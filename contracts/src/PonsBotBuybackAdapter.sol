// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20BuybackAdapter {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPonsBotVaultRegistry {
    function isVault(address candidate) external view returns (bool);
}

interface IPonsBotProcessingControl {
    function processingEnabled() external view returns (bool);
    function admin() external view returns (address);
    function pauseGuardian() external view returns (address);
}

interface IPonsBotBuybackExecutor {
    function executeBuyback(
        address pairAsset,
        uint256 amountIn,
        address ponsbot,
        address burnAddress,
        uint256 minPonsbotOut,
        uint256 deadline,
        bytes calldata routeData
    ) external payable returns (uint256 reportedPonsbotBurned);
}

/// @notice Restricted execution boundary between recognized fee vaults and
/// timelocked, bytecode-pinned buyback executors. The executor receives the
/// actual post-claim amount instead of relying on stale amount calldata.
contract PonsBotBuybackAdapter {
    uint256 public constant MAX_EXECUTION_DEADLINE_WINDOW = 10 minutes;
    address public constant NATIVE_ASSET = address(0);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable vaultFactory;
    address public immutable feeControl;
    address public immutable canonicalPonsbot;
    bool private entered;

    mapping(address executor => bool allowed) public allowedExecutor;
    mapping(address executor => bytes32 codeHash) public allowedExecutorCodeHash;
    event ExecutorUpdated(address indexed executor, bool allowed, bytes32 codeHash);

    error Unauthorized();
    error InvalidConfiguration();
    error ExecutorNotAllowed();
    error ProcessingPaused();
    error TransferFailed();
    error BuybackVerificationFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(address vaultFactory_, address feeControl_, address ponsbot_) {
        if (vaultFactory_ == address(0) || feeControl_ == address(0) || ponsbot_ == address(0)) {
            revert InvalidConfiguration();
        }
        if (vaultFactory_.code.length == 0 || feeControl_.code.length == 0 || ponsbot_.code.length == 0) {
            revert InvalidConfiguration();
        }
        vaultFactory = vaultFactory_;
        feeControl = feeControl_;
        canonicalPonsbot = ponsbot_;
    }

    receive() external payable {}

    function buyAndBurn(
        address pairAsset,
        uint256 amountIn,
        address ponsbot,
        address burnAddress,
        uint256 minPonsbotOut,
        uint256 deadline,
        address executor,
        bytes calldata routeData
    ) external payable nonReentrant returns (uint256 burned) {
        if (!IPonsBotVaultRegistry(vaultFactory).isVault(msg.sender)) revert Unauthorized();
        if (!IPonsBotProcessingControl(feeControl).processingEnabled()) revert ProcessingPaused();
        if (
            amountIn == 0 || ponsbot != canonicalPonsbot
                || burnAddress != BURN_ADDRESS || executor == address(0)
                || executor.code.length == 0 || minPonsbotOut == 0 || block.timestamp > deadline
                || deadline > block.timestamp + MAX_EXECUTION_DEADLINE_WINDOW
        ) revert InvalidConfiguration();
        if (!allowedExecutor[executor] || allowedExecutorCodeHash[executor] != executor.codehash) {
            revert ExecutorNotAllowed();
        }

        uint256 deadBefore = IERC20BuybackAdapter(ponsbot).balanceOf(burnAddress);
        uint256 reported;
        if (pairAsset == NATIVE_ASSET) {
            if (msg.value != amountIn) revert InvalidConfiguration();
            uint256 nativeBefore = address(this).balance - msg.value;
            reported = IPonsBotBuybackExecutor(executor).executeBuyback{value: amountIn}(
                pairAsset, amountIn, ponsbot, burnAddress, minPonsbotOut, deadline, routeData
            );
            if (address(this).balance != nativeBefore) revert BuybackVerificationFailed();
        } else {
            if (msg.value != 0) revert InvalidConfiguration();
            uint256 pairBefore = IERC20BuybackAdapter(pairAsset).balanceOf(address(this));
            _safeTransferFrom(pairAsset, msg.sender, address(this), amountIn);
            if (IERC20BuybackAdapter(pairAsset).balanceOf(address(this)) - pairBefore != amountIn) {
                revert BuybackVerificationFailed();
            }
            _safeApprove(pairAsset, executor, 0);
            _safeApprove(pairAsset, executor, amountIn);
            reported = IPonsBotBuybackExecutor(executor)
                .executeBuyback(pairAsset, amountIn, ponsbot, burnAddress, minPonsbotOut, deadline, routeData);
            _safeApprove(pairAsset, executor, 0);
            if (IERC20BuybackAdapter(pairAsset).balanceOf(address(this)) != pairBefore) {
                revert BuybackVerificationFailed();
            }
        }
        burned = IERC20BuybackAdapter(ponsbot).balanceOf(burnAddress) - deadBefore;
        if (burned < minPonsbotOut || reported != burned) revert BuybackVerificationFailed();
    }

    function setExecutor(address executor, bool allowed) external {
        if (msg.sender != IPonsBotProcessingControl(feeControl).admin()) revert Unauthorized();
        if (IPonsBotProcessingControl(feeControl).processingEnabled()) revert InvalidConfiguration();
        if (executor == address(0) || executor.code.length == 0) revert InvalidConfiguration();
        allowedExecutor[executor] = allowed;
        bytes32 codeHash = allowed ? executor.codehash : bytes32(0);
        allowedExecutorCodeHash[executor] = codeHash;
        emit ExecutorUpdated(executor, allowed, codeHash);
    }

    function disableExecutor(address executor) external {
        IPonsBotProcessingControl control = IPonsBotProcessingControl(feeControl);
        if (msg.sender != control.admin() && msg.sender != control.pauseGuardian()) revert Unauthorized();
        allowedExecutor[executor] = false;
        allowedExecutorCodeHash[executor] = bytes32(0);
        emit ExecutorUpdated(executor, false, bytes32(0));
    }

    function _safeTransferFrom(address asset, address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) =
            asset.call(abi.encodeCall(IERC20BuybackAdapter.transferFrom, (from, to, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address asset, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20BuybackAdapter.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
