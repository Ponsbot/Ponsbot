// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20NativeBuybackExecutor {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IPonsFactoryNativeBuybackExecutor {
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
    function memeHook() external view returns (address);
}

interface IUniversalRouterNativeBuybackExecutor {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Canonical native-asset -> PONSBOT V4 executor for the automated
/// creator-fee program. It derives the complete pool key from the Pons factory,
/// accepts no arbitrary route calldata, and may only be called by the adapter.
contract PonsBotNativeBuybackExecutor {
    address public constant NATIVE_ASSET = address(0);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_EXECUTION_DEADLINE_WINDOW = 10 minutes;

    bytes private constant UNIVERSAL_ROUTER_V4_SWAP = hex"10";
    bytes private constant V4_ACTIONS = hex"060f0c"; // exact-in single, take-all, settle-all

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    address public immutable adapter;
    address public immutable ponsFactory;
    address public immutable universalRouter;
    address public immutable canonicalPonsbot;
    address public immutable canonicalHook;
    uint24 public immutable canonicalPoolFee;
    int24 public immutable canonicalTickSpacing;
    bytes32 public immutable ponsFactoryCodeHash;
    bytes32 public immutable universalRouterCodeHash;
    bytes32 public immutable canonicalPonsbotCodeHash;
    bytes32 public immutable canonicalHookCodeHash;
    bool private entered;

    error Unauthorized();
    error InvalidConfiguration();
    error TransferFailed();
    error BuybackVerificationFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(address adapter_, address ponsFactory_, address universalRouter_, address ponsbot_) {
        if (
            adapter_ == address(0) || ponsFactory_ == address(0) || universalRouter_ == address(0)
                || ponsbot_ == address(0)
        ) revert InvalidConfiguration();
        if (
            adapter_.code.length == 0 || ponsFactory_.code.length == 0 || universalRouter_.code.length == 0
                || ponsbot_.code.length == 0
        ) revert InvalidConfiguration();
        adapter = adapter_;
        ponsFactory = ponsFactory_;
        universalRouter = universalRouter_;
        canonicalPonsbot = ponsbot_;
        ponsFactoryCodeHash = ponsFactory_.codehash;
        universalRouterCodeHash = universalRouter_.codehash;
        canonicalPonsbotCodeHash = ponsbot_.codehash;
        IPonsFactoryNativeBuybackExecutor.LaunchedToken memory launched =
            IPonsFactoryNativeBuybackExecutor(ponsFactory_).getLaunchedToken(ponsbot_);
        address hook = IPonsFactoryNativeBuybackExecutor(ponsFactory_).memeHook();
        if (
            !launched.exists || launched.token != ponsbot_ || launched.pairToken != NATIVE_ASSET
                || launched.phase != 2 || launched.tickSpacing == 0 || hook == address(0) || hook.code.length == 0
        ) revert InvalidConfiguration();
        canonicalHook = hook;
        canonicalPoolFee = launched.poolFee;
        canonicalTickSpacing = launched.tickSpacing;
        canonicalHookCodeHash = hook.codehash;
    }

    receive() external payable {}

    function executeBuyback(
        address pairAsset,
        uint256 amountIn,
        address ponsbot,
        address burnAddress,
        uint256 minPonsbotOut,
        uint256 deadline,
        bytes calldata routeData
    ) external payable nonReentrant returns (uint256 ponsbotBurned) {
        if (msg.sender != adapter) revert Unauthorized();
        if (
            pairAsset != NATIVE_ASSET || ponsbot != canonicalPonsbot || burnAddress != BURN_ADDRESS || amountIn == 0
                || amountIn > type(uint128).max || minPonsbotOut == 0 || minPonsbotOut > type(uint128).max
                || msg.value != amountIn || block.timestamp > deadline
                || deadline > block.timestamp + MAX_EXECUTION_DEADLINE_WINDOW || routeData.length != 0
        ) revert InvalidConfiguration();
        if (
            ponsFactory.codehash != ponsFactoryCodeHash || universalRouter.codehash != universalRouterCodeHash
                || canonicalPonsbot.codehash != canonicalPonsbotCodeHash || canonicalHook.codehash != canonicalHookCodeHash
        ) {
            revert InvalidConfiguration();
        }

        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 tokenBefore = IERC20NativeBuybackExecutor(canonicalPonsbot).balanceOf(address(this));
        _executeCanonicalSwap(amountIn, minPonsbotOut, deadline);

        if (address(this).balance != nativeBefore) revert BuybackVerificationFailed();
        ponsbotBurned = IERC20NativeBuybackExecutor(canonicalPonsbot).balanceOf(address(this)) - tokenBefore;
        if (ponsbotBurned < minPonsbotOut) revert BuybackVerificationFailed();
        _safeTransfer(canonicalPonsbot, burnAddress, ponsbotBurned);
    }

    function _executeCanonicalSwap(uint256 amountIn, uint256 minPonsbotOut, uint256 deadline) private {
        IPonsFactoryNativeBuybackExecutor.LaunchedToken memory launched =
            IPonsFactoryNativeBuybackExecutor(ponsFactory).getLaunchedToken(canonicalPonsbot);
        if (
            !launched.exists || launched.token != canonicalPonsbot || launched.pairToken != NATIVE_ASSET
                || launched.poolFee != canonicalPoolFee || launched.tickSpacing != canonicalTickSpacing
        ) revert InvalidConfiguration();

        address hook = IPonsFactoryNativeBuybackExecutor(ponsFactory).memeHook();
        if (hook != canonicalHook || hook.codehash != canonicalHookCodeHash) revert InvalidConfiguration();

        PoolKey memory poolKey = PoolKey({
            currency0: NATIVE_ASSET,
            currency1: canonicalPonsbot,
            fee: launched.poolFee,
            tickSpacing: launched.tickSpacing,
            hooks: hook
        });
        ExactInputSingleParams memory swap = ExactInputSingleParams({
            poolKey: poolKey,
            zeroForOne: true,
            amountIn: uint128(amountIn),
            amountOutMinimum: uint128(minPonsbotOut),
            minHopPriceX36: 0,
            hookData: bytes("")
        });

        bytes[] memory actionParameters = new bytes[](3);
        actionParameters[0] = abi.encode(swap);
        actionParameters[1] = abi.encode(canonicalPonsbot, minPonsbotOut);
        actionParameters[2] = abi.encode(NATIVE_ASSET, amountIn);
        bytes[] memory routerInputs = new bytes[](1);
        routerInputs[0] = abi.encode(V4_ACTIONS, actionParameters);

        IUniversalRouterNativeBuybackExecutor(universalRouter).execute{value: amountIn}(
            UNIVERSAL_ROUTER_V4_SWAP, routerInputs, deadline
        );
    }

    function _safeTransfer(address asset, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) =
            asset.call(abi.encodeCall(IERC20NativeBuybackExecutor.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
