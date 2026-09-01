// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20FeeVault {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external;
    function claimToken(address token) external;
}

interface IPonsFeeCurve {
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsFeeFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }
    function getLaunchedToken(address token) external view returns (LaunchedToken memory launched);
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
    function memeHook() external view returns (address);
}

interface IPonsFeeHook {
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
    function pendingFees(bytes32 poolId, address currency) external view returns (uint256);
    function pendingCreatorTax(bytes32 poolId, address currency) external view returns (uint256);
}

interface IPonsBotBuybackAdapter {
    /// @dev Must spend no more than amountIn and deliver purchased PONSBOT to burnAddress.
    function buyAndBurn(
        address pairAsset,
        uint256 amountIn,
        address ponsbot,
        address burnAddress,
        uint256 minPonsbotOut,
        uint256 deadline,
        address target,
        bytes calldata routeData
    ) external payable returns (uint256 reportedPonsbotBurned);
}

interface IPonsBotFeeControl {
    function processingEnabled() external view returns (bool);
    function keeper() external view returns (address);
    function admin() external view returns (address);
    function pauseGuardian() external view returns (address);
    function executionAdapter() external view returns (address);
    function quoteAuthorizer() external view returns (address);
}

contract PonsBotFeeVault {
    uint16 public constant BUYBACK_BPS = 500;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @dev The threshold is denominated in the pair asset's smallest unit. It
    /// prevents repeated dust claims from biasing the 95/5 integer split.
    uint256 public constant MINIMUM_GROSS_CLAIM = 10_000;
    address public constant NATIVE_ASSET = address(0);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EXECUTION_AUTHORIZATION_TYPEHASH = keccak256(
        "ExecutionAuthorization(address pairAsset,uint256 maxBuybackAmount,uint256 minPonsbotOut,uint256 minSweepBuybackTokensOut,uint256 deadline,address routeTarget,bytes32 routeDataHash,uint256 nonce)"
    );
    bytes32 private constant NAME_HASH = keccak256("PonsBotFeeVault");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Initialization {
        address token;
        address curve;
        address pairAsset;
        address ponsFactory;
        address feeEscrow;
        address ponsbot;
        address controller;
        address beneficiary;
        address feeControl;
    }

    struct ExecutionAuthorization {
        uint256 maxBuybackAmount;
        uint256 minPonsbotOut;
        uint256 minSweepBuybackTokensOut;
        uint256 deadline;
        address routeTarget;
        bytes routeData;
        bytes quoteSignature;
    }

    bool public initialized;
    bool public active;
    bool public paused;
    bool private entered;

    address public vaultFactory;
    address public token;
    address public curve;
    address public pairAsset;
    address public ponsFactory;
    address public feeEscrow;
    address public ponsbot;
    address public controller;
    address public beneficiary;
    address public feeControl;

    mapping(address beneficiaryAddress => mapping(address asset => uint256 amount)) public claimable;
    mapping(address asset => uint256 amount) public lifetimeGrossClaimed;
    mapping(address asset => uint256 amount) public lifetimeBeneficiaryAllocated;
    mapping(address asset => uint256 amount) public lifetimeBuybackSpent;
    uint256 public lifetimePonsbotBurned;
    uint256 public executionNonce;
    uint256 public lastCurveSweepBlock;
    uint256 public lastGraduatedSweepBlock;

    event Initialized(
        address indexed token, address indexed controller, address indexed beneficiary, address pairAsset
    );
    event FeesProcessed(
        address indexed asset,
        uint256 grossClaimed,
        uint256 beneficiaryAllocated,
        uint256 buybackSpent,
        uint256 ponsbotBurned
    );
    event CurveFeesSwept(address indexed token, uint256 indexed blockNumber, uint256 minBuybackTokensOut);
    event GraduatedFeesSwept(
        address indexed token,
        bytes32 indexed poolId,
        uint256 indexed blockNumber,
        uint256 minConversionQuoteOut,
        uint256 minBuybackTokensOut
    );
    event BeneficiaryWithdrawal(
        address indexed beneficiary, address indexed asset, address indexed recipient, uint256 amount
    );
    event BeneficiaryAllocationDelivered(address indexed beneficiary, address indexed asset, uint256 amount);
    event ControlReassigned(
        address indexed previousController,
        address indexed newController,
        address previousBeneficiary,
        address newBeneficiary
    );
    event PauseStateChanged(bool paused);
    event Exited(address indexed previousController, address indexed newPonsFeeRecipient);
    event EmergencyFeesAllocated(address indexed asset, address indexed beneficiary, uint256 amount);

    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyInitialized();
    error Inactive();
    error ProcessingPaused();
    error Reentrancy();
    error NothingClaimed();
    error PreGraduationProcessingRequiresSeparateSweep();
    error BuybackVerificationFailed();
    error TransferFailed();

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }
    modifier onlyKeeper() {
        if (msg.sender != IPonsBotFeeControl(feeControl).keeper()) revert Unauthorized();
        _;
    }
    modifier onlyAdmin() {
        if (msg.sender != IPonsBotFeeControl(feeControl).admin()) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    receive() external payable {}

    /// @dev Locks the implementation instance itself. Proxy clones use their
    /// own storage and remain initializable exactly once by the vault factory.
    constructor() {
        initialized = true;
    }

    function initialize(Initialization calldata init) external {
        if (initialized) revert AlreadyInitialized();
        if (
            init.token == address(0) || init.curve == address(0) || init.ponsFactory == address(0)
                || init.feeEscrow == address(0) || init.ponsbot == address(0) || init.controller == address(0)
                || init.beneficiary == address(0) || init.controller != init.beneficiary || init.feeControl == address(0)
        ) revert InvalidConfiguration();
        IPonsFeeFactory.LaunchedToken memory launched =
            IPonsFeeFactory(init.ponsFactory).getLaunchedToken(init.token);
        if (
            !launched.exists || launched.token != init.token || launched.curve != init.curve
                || launched.pairToken != init.pairAsset || launched.phase == 3
                || (launched.creatorFeeRecipient != init.controller && launched.creatorFeeRecipient != address(this))
        ) revert InvalidConfiguration();
        initialized = true;
        active = true;
        vaultFactory = msg.sender;
        token = init.token;
        curve = init.curve;
        pairAsset = init.pairAsset;
        ponsFactory = init.ponsFactory;
        feeEscrow = init.feeEscrow;
        ponsbot = init.ponsbot;
        controller = init.controller;
        beneficiary = init.beneficiary;
        feeControl = init.feeControl;
        emit Initialized(init.token, init.controller, init.beneficiary, init.pairAsset);
    }

    function processFees(ExecutionAuthorization calldata execution)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 gross, uint256 burned)
    {
        if (!active) revert Inactive();
        if (paused) revert ProcessingPaused();
        if (!IPonsBotFeeControl(feeControl).processingEnabled()) revert ProcessingPaused();
        if (execution.deadline < block.timestamp) revert InvalidConfiguration();

        IPonsFeeFactory.LaunchedToken memory launched = _validatedLaunch();
        if (launched.phase != 0 && launched.phase != 2) revert InvalidConfiguration();
        if (launched.phase == 0 && lastCurveSweepBlock == 0) revert PreGraduationProcessingRequiresSeparateSweep();
        gross = _claimAvailable(true);
        if (gross == 0) revert NothingClaimed();
        burned = _allocateAndBurn(gross, execution);
        // A bonding-curve processing cycle always requires a newly confirmed
        // sweep. Graduation makes this marker irrelevant but clearing it keeps
        // the state machine unambiguous across phase transitions.
        lastCurveSweepBlock = 0;
    }

    function sweepCurveFees(uint256 minBuybackTokensOut) external onlyKeeper nonReentrant {
        if (!active) revert Inactive();
        if (paused || !IPonsBotFeeControl(feeControl).processingEnabled()) revert ProcessingPaused();
        IPonsFeeFactory.LaunchedToken memory launched = _validatedLaunch();
        if (launched.phase != 0) revert InvalidConfiguration();
        IPonsFeeCurve(curve).sweepFees(minBuybackTokensOut);
        lastCurveSweepBlock = block.number;
        emit CurveFeesSwept(token, block.number, minBuybackTokensOut);
    }

    /// @notice Attempts the creator-callable Pons V2 hook sweep. Pons may
    /// require its sweep operator when conversion or its own buyback is needed;
    /// in that case this call safely reverts and processing can resume after the
    /// protocol operator has swept the pool into escrow.
    function sweepGraduatedFees(uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
        onlyKeeper
        nonReentrant
    {
        if (!active) revert Inactive();
        if (paused || !IPonsBotFeeControl(feeControl).processingEnabled()) revert ProcessingPaused();
        IPonsFeeFactory.LaunchedToken memory launched = _validatedLaunch();
        if (launched.phase != 2) revert InvalidConfiguration();
        bytes32 poolId = _poolId(launched);
        IPonsFeeHook(IPonsFeeFactory(ponsFactory).memeHook()).sweepPoolFees(
            poolId, minConversionQuoteOut, minBuybackTokensOut
        );
        lastGraduatedSweepBlock = block.number;
        emit GraduatedFeesSwept(token, poolId, block.number, minConversionQuoteOut, minBuybackTokensOut);
    }

    /// @notice Delivers accrued allocations to the beneficiary that earned them.
    /// The destination is fixed by accounting and cannot be selected by the keeper.
    function deliverBeneficiaryAllocation(address beneficiaryAddress, address asset, uint256 amount)
        external
        onlyKeeper
        nonReentrant
    {
        if (beneficiaryAddress == address(0) || amount == 0) revert InvalidConfiguration();
        uint256 available = claimable[beneficiaryAddress][asset];
        if (amount > available) revert InvalidConfiguration();
        claimable[beneficiaryAddress][asset] = available - amount;
        if (asset == NATIVE_ASSET) {
            (bool ok,) = beneficiaryAddress.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(asset, beneficiaryAddress, amount);
        }
        emit BeneficiaryAllocationDelivered(beneficiaryAddress, asset, amount);
    }

    function withdraw(address asset, address recipient, uint256 amount) external nonReentrant {
        if (recipient == address(0) || amount == 0) revert InvalidConfiguration();
        uint256 available = claimable[msg.sender][asset];
        if (amount > available) revert InvalidConfiguration();
        claimable[msg.sender][asset] = available - amount;
        if (asset == NATIVE_ASSET) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(asset, recipient, amount);
        }
        emit BeneficiaryWithdrawal(msg.sender, asset, recipient, amount);
    }

    /// @notice Settles every currently available fee for the existing beneficiary
    /// before transferring both future payout rights and configuration control.
    function settleAndReassign(
        address newController,
        address newBeneficiary,
        ExecutionAuthorization calldata execution
    ) external onlyController nonReentrant returns (uint256 gross, uint256 burned) {
        if (!active) revert Inactive();
        if (paused || !IPonsBotFeeControl(feeControl).processingEnabled()) revert ProcessingPaused();
        if (newController == address(0) || newBeneficiary == address(0) || newController != newBeneficiary) {
            revert InvalidConfiguration();
        }
        if (execution.deadline < block.timestamp) revert InvalidConfiguration();
        IPonsFeeFactory.LaunchedToken memory launched = _validatedLaunch();
        if (launched.phase != 0 && launched.phase != 2) revert InvalidConfiguration();
        if (launched.phase == 0 && lastCurveSweepBlock == 0) revert PreGraduationProcessingRequiresSeparateSweep();
        // Escrow already credited before reassignment is claimed for the old
        // beneficiary above. Unswept hook fees follow the new beneficiary when
        // Pons later sweeps them, so active pools do not need to reach a
        // momentary zero-pending state before control can move.
        gross = _claimAvailable(false);
        if (gross != 0) {
            if (gross < MINIMUM_GROSS_CLAIM) {
                claimable[beneficiary][pairAsset] += gross;
                lifetimeGrossClaimed[pairAsset] += gross;
                lifetimeBeneficiaryAllocated[pairAsset] += gross;
                emit FeesProcessed(pairAsset, gross, gross, 0, 0);
            } else {
                burned = _allocateAndBurn(gross, execution);
            }
        }
        address oldController = controller;
        address oldBeneficiary = beneficiary;
        controller = newController;
        beneficiary = newBeneficiary;
        lastCurveSweepBlock = 0;
        lastGraduatedSweepBlock = 0;
        emit ControlReassigned(oldController, newController, oldBeneficiary, newBeneficiary);
    }

    /// @notice Leaves automated routing while paused. Any fees already earned are
    /// swept and credited entirely to the current beneficiary before future Pons
    /// creator-fee rights are transferred. No emergency-exit buyback is attempted.
    function exit(address newPonsFeeRecipient) external onlyController nonReentrant {
        if (!active) revert Inactive();
        if (!paused) revert ProcessingPaused();
        if (newPonsFeeRecipient == address(0) || newPonsFeeRecipient == address(this)) revert InvalidConfiguration();
        IPonsFeeFactory.LaunchedToken memory launched = _validatedLaunch();
        if (launched.phase == 0) {
            IPonsFeeCurve(curve).sweepFees(0);
        } else if (launched.phase != 2) {
            revert InvalidConfiguration();
        }
        uint256 emergencyGross = _claimAvailable(false);
        if (emergencyGross != 0) {
            claimable[beneficiary][pairAsset] += emergencyGross;
            lifetimeGrossClaimed[pairAsset] += emergencyGross;
            lifetimeBeneficiaryAllocated[pairAsset] += emergencyGross;
            emit EmergencyFeesAllocated(pairAsset, beneficiary, emergencyGross);
        }
        address oldController = controller;
        IPonsFeeFactory(ponsFactory).transferCreatorFeeRecipient(token, newPonsFeeRecipient);
        active = false;
        emit Exited(oldController, newPonsFeeRecipient);
    }

    function pause() external {
        IPonsBotFeeControl control = IPonsBotFeeControl(feeControl);
        if (msg.sender != controller && msg.sender != control.pauseGuardian() && msg.sender != control.admin()) {
            revert Unauthorized();
        }
        paused = true;
        emit PauseStateChanged(true);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit PauseStateChanged(false);
    }

    function _assetBalance(address asset, address account) private view returns (uint256) {
        return asset == NATIVE_ASSET ? account.balance : IERC20FeeVault(asset).balanceOf(account);
    }

    function _validatedLaunch() private view returns (IPonsFeeFactory.LaunchedToken memory launched) {
        launched = IPonsFeeFactory(ponsFactory).getLaunchedToken(token);
        if (
            !launched.exists || launched.token != token || launched.curve != curve || launched.pairToken != pairAsset
                || launched.creatorFeeRecipient != address(this)
        ) revert InvalidConfiguration();
    }

    function _poolId(IPonsFeeFactory.LaunchedToken memory launched) private view returns (bytes32) {
        address hook = IPonsFeeFactory(ponsFactory).memeHook();
        if (hook == address(0) || hook.code.length == 0) revert InvalidConfiguration();
        address currency0 = uint160(pairAsset) < uint160(token) ? pairAsset : token;
        address currency1 = currency0 == pairAsset ? token : pairAsset;
        return keccak256(abi.encode(currency0, currency1, launched.poolFee, launched.tickSpacing, hook));
    }

    function _claimAvailable(bool enforceMinimum) private returns (uint256 gross) {
        uint256 available = pairAsset == NATIVE_ASSET
            ? IPonsFeeEscrow(feeEscrow).balanceOf(address(this))
            : IPonsFeeEscrow(feeEscrow).balanceOfToken(address(this), pairAsset);
        if (enforceMinimum && available < MINIMUM_GROSS_CLAIM) revert NothingClaimed();
        uint256 beforeClaim = _assetBalance(pairAsset, address(this));
        if (pairAsset == NATIVE_ASSET) IPonsFeeEscrow(feeEscrow).claim();
        else IPonsFeeEscrow(feeEscrow).claimToken(pairAsset);
        gross = _assetBalance(pairAsset, address(this)) - beforeClaim;
    }

    function _allocateAndBurn(uint256 gross, ExecutionAuthorization calldata execution)
        private
        returns (uint256 burned)
    {
        uint256 buyback = gross * BUYBACK_BPS / BPS_DENOMINATOR;
        uint256 allocation = gross - buyback;
        claimable[beneficiary][pairAsset] += allocation;
        lifetimeGrossClaimed[pairAsset] += gross;
        lifetimeBeneficiaryAllocated[pairAsset] += allocation;
        lifetimeBuybackSpent[pairAsset] += buyback;
        if (buyback != 0) {
            if (buyback > execution.maxBuybackAmount) revert InvalidConfiguration();
            bytes32 authorizationDigest = executionAuthorizationDigest(
                execution.maxBuybackAmount,
                execution.minPonsbotOut,
                execution.minSweepBuybackTokensOut,
                execution.deadline,
                execution.routeTarget,
                keccak256(execution.routeData),
                executionNonce
            );
            _verifyExecutionAuthorization(authorizationDigest, execution.quoteSignature);
            unchecked {
                ++executionNonce;
            }
            burned = _executeBuyback(
                buyback,
                execution.minPonsbotOut,
                execution.deadline,
                execution.routeTarget,
                execution.routeData
            );
            lifetimePonsbotBurned += burned;
        }
        emit FeesProcessed(pairAsset, gross, allocation, buyback, burned);
    }

    function executionAuthorizationDigest(
        uint256 maxBuybackAmount,
        uint256 minPonsbotOut,
        uint256 minSweepBuybackTokensOut,
        uint256 deadline,
        address routeTarget,
        bytes32 routeDataHash,
        uint256 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_AUTHORIZATION_TYPEHASH,
                pairAsset,
                maxBuybackAmount,
                minPonsbotOut,
                minSweepBuybackTokensOut,
                deadline,
                routeTarget,
                routeDataHash,
                nonce
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _verifyExecutionAuthorization(bytes32 digest, bytes calldata signature) private view {
        if (signature.length != 65) revert Unauthorized();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) revert Unauthorized();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != IPonsBotFeeControl(feeControl).quoteAuthorizer()) {
            revert Unauthorized();
        }
    }

    function _executeBuyback(
        uint256 buyback,
        uint256 minPonsbotOut,
        uint256 deadline,
        address routeTarget,
        bytes calldata routeData
    ) private returns (uint256 burned) {
        if (minPonsbotOut == 0) revert InvalidConfiguration();
        address adapter = IPonsBotFeeControl(feeControl).executionAdapter();
        if (adapter == address(0)) revert InvalidConfiguration();
        uint256 deadBefore = IERC20FeeVault(ponsbot).balanceOf(BURN_ADDRESS);
        uint256 reported;
        if (pairAsset == NATIVE_ASSET) {
            reported = IPonsBotBuybackAdapter(adapter).buyAndBurn{value: buyback}(
                pairAsset, buyback, ponsbot, BURN_ADDRESS, minPonsbotOut, deadline, routeTarget, routeData
            );
        } else {
            uint256 pairBefore = IERC20FeeVault(pairAsset).balanceOf(address(this));
            _safeApprove(pairAsset, adapter, 0);
            _safeApprove(pairAsset, adapter, buyback);
            reported = IPonsBotBuybackAdapter(adapter)
                .buyAndBurn(pairAsset, buyback, ponsbot, BURN_ADDRESS, minPonsbotOut, deadline, routeTarget, routeData);
            _safeApprove(pairAsset, adapter, 0);
            if (pairBefore - IERC20FeeVault(pairAsset).balanceOf(address(this)) != buyback) {
                revert BuybackVerificationFailed();
            }
        }
        burned = IERC20FeeVault(ponsbot).balanceOf(BURN_ADDRESS) - deadBefore;
        if (burned < minPonsbotOut || reported != burned) revert BuybackVerificationFailed();
    }

    function _safeTransfer(address asset, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20FeeVault.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address asset, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20FeeVault.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
