// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20PairedBuybackExecutor {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IPermit2PairedBuybackExecutor {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IWethPairedBuybackExecutor {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 amount) external;
}

interface IV3RouterPairedBuybackExecutor {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IPonsBotControlPairedBuybackExecutor {
    function admin() external view returns (address);
    function processingEnabled() external view returns (bool);
}

interface IPonsFactoryPairedBuybackExecutor {
    struct LaunchedToken {
        address token; address curve; address deployer; address creatorFeeRecipient; address pairToken;
        uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps;
        bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists;
    }
    function getLaunchedToken(address token) external view returns (LaunchedToken memory launched);
    function memeHook() external view returns (address);
}

interface IUniversalRouterPairedBuybackExecutor {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Canonical pair-token -> native -> PONSBOT V4 executor. The pair
/// asset must itself be a graduated Pons token paired with native ETH. The only
/// route parameter is the independently quoted first-hop minimum.
contract PonsBotPairedBuybackExecutor {
    address public constant NATIVE_ASSET = address(0);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_EXECUTION_DEADLINE_WINDOW = 10 minutes;
    bytes private constant V4_SWAP_COMMAND = hex"10";
    bytes private constant V4_ACTIONS = hex"060f0c";

    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct ExactInputSingleParams {
        PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum;
        uint256 minHopPriceX36; bytes hookData;
    }

    enum PairRouteKind { Unset, V3Direct, V4Direct }
    struct PairRoute {
        PairRouteKind kind;
        uint24 fee;
        int24 tickSpacing;
        address hook;
        bytes32 hookCodeHash;
    }

    address public immutable adapter;
    address public immutable ponsFactory;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable v3Router;
    address public immutable weth;
    address public immutable feeControl;
    address public immutable canonicalPonsbot;
    address public immutable canonicalHook;
    uint24 public immutable canonicalPoolFee;
    int24 public immutable canonicalTickSpacing;
    bytes32 public immutable ponsFactoryCodeHash;
    bytes32 public immutable universalRouterCodeHash;
    bytes32 public immutable permit2CodeHash;
    bytes32 public immutable v3RouterCodeHash;
    bytes32 public immutable wethCodeHash;
    bytes32 public immutable feeControlCodeHash;
    bytes32 public immutable ponsbotCodeHash;
    bytes32 public immutable hookCodeHash;
    bool private entered;
    mapping(address pairAsset => PairRoute route) public pairRoutes;

    event PairRouteConfigured(
        address indexed pairAsset, PairRouteKind kind, uint24 fee, int24 tickSpacing, address indexed hook
    );

    error Unauthorized(); error InvalidConfiguration(); error TransferFailed();
    error BuybackVerificationFailed(); error Reentrancy();

    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }
    receive() external payable {}

    constructor(
        address adapter_, address factory_, address router_, address permit2_, address v3Router_, address weth_,
        address feeControl_, address ponsbot_
    ) {
        if (adapter_ == address(0) || factory_ == address(0) || router_ == address(0) || permit2_ == address(0)
            || v3Router_ == address(0) || weth_ == address(0) || feeControl_ == address(0) || ponsbot_ == address(0)) revert InvalidConfiguration();
        if (adapter_.code.length == 0 || factory_.code.length == 0 || router_.code.length == 0
            || permit2_.code.length == 0 || v3Router_.code.length == 0 || weth_.code.length == 0
            || feeControl_.code.length == 0 || ponsbot_.code.length == 0) revert InvalidConfiguration();
        address hook = IPonsFactoryPairedBuybackExecutor(factory_).memeHook();
        if (hook == address(0) || hook.code.length == 0) revert InvalidConfiguration();
        IPonsFactoryPairedBuybackExecutor.LaunchedToken memory p = IPonsFactoryPairedBuybackExecutor(factory_).getLaunchedToken(ponsbot_);
        if (!p.exists || p.pairToken != NATIVE_ASSET || p.phase != 2 || p.tickSpacing == 0) {
            revert InvalidConfiguration();
        }
        adapter = adapter_; ponsFactory = factory_; universalRouter = router_; permit2 = permit2_;
        v3Router = v3Router_; weth = weth_; feeControl = feeControl_;
        canonicalPonsbot = ponsbot_; canonicalHook = hook;
        canonicalPoolFee = p.poolFee; canonicalTickSpacing = p.tickSpacing;
        ponsFactoryCodeHash = factory_.codehash; universalRouterCodeHash = router_.codehash;
        permit2CodeHash = permit2_.codehash; v3RouterCodeHash = v3Router_.codehash; wethCodeHash = weth_.codehash;
        feeControlCodeHash = feeControl_.codehash; ponsbotCodeHash = ponsbot_.codehash; hookCodeHash = hook.codehash;
    }

    function configurePairRoute(address pairAsset, PairRouteKind kind, uint24 fee, int24 tickSpacing, address hook)
        external
    {
        IPonsBotControlPairedBuybackExecutor control = IPonsBotControlPairedBuybackExecutor(feeControl);
        if (msg.sender != control.admin()) revert Unauthorized();
        if (control.processingEnabled() || pairAsset == NATIVE_ASSET || pairAsset == canonicalPonsbot
            || pairAsset.code.length == 0 || kind == PairRouteKind.Unset) revert InvalidConfiguration();
        bytes32 configuredHookHash;
        if (kind == PairRouteKind.V3Direct) {
            if (fee == 0 || tickSpacing != 0 || hook != address(0)) revert InvalidConfiguration();
        } else {
            if (tickSpacing == 0) revert InvalidConfiguration();
            if (hook != address(0)) {
                if (hook.code.length == 0) revert InvalidConfiguration();
                configuredHookHash = hook.codehash;
            }
        }
        pairRoutes[pairAsset] = PairRoute(kind, fee, tickSpacing, hook, configuredHookHash);
        emit PairRouteConfigured(pairAsset, kind, fee, tickSpacing, hook);
    }

    function clearPairRoute(address pairAsset) external {
        IPonsBotControlPairedBuybackExecutor control = IPonsBotControlPairedBuybackExecutor(feeControl);
        if (msg.sender != control.admin()) revert Unauthorized();
        if (control.processingEnabled()) revert InvalidConfiguration();
        delete pairRoutes[pairAsset];
        emit PairRouteConfigured(pairAsset, PairRouteKind.Unset, 0, 0, address(0));
    }

    function executeBuyback(address pairAsset, uint256 amountIn, address ponsbot, address burnAddress,
        uint256 minPonsbotOut, uint256 deadline, bytes calldata routeData)
        external payable nonReentrant returns (uint256 burned)
    {
        if (msg.sender != adapter) revert Unauthorized();
        if (pairAsset == NATIVE_ASSET || ponsbot != canonicalPonsbot || burnAddress != BURN_ADDRESS || msg.value != 0
            || amountIn == 0 || amountIn > type(uint128).max || minPonsbotOut == 0 || minPonsbotOut > type(uint128).max
            || block.timestamp > deadline || deadline > block.timestamp + MAX_EXECUTION_DEADLINE_WINDOW) revert InvalidConfiguration();
        if (ponsFactory.codehash != ponsFactoryCodeHash || universalRouter.codehash != universalRouterCodeHash
            || permit2.codehash != permit2CodeHash || v3Router.codehash != v3RouterCodeHash
            || weth.codehash != wethCodeHash || feeControl.codehash != feeControlCodeHash
            || canonicalPonsbot.codehash != ponsbotCodeHash
            || canonicalHook.codehash != hookCodeHash) revert InvalidConfiguration();
        uint256 minNativeOut = abi.decode(routeData, (uint256));
        if (minNativeOut == 0 || minNativeOut > type(uint128).max) revert InvalidConfiguration();
        // The adapter deliberately retains custody until it has validated the vault
        // and executor. Pull exactly the approved amount before touching Permit2.
        _safeTransferFrom(pairAsset, msg.sender, address(this), amountIn);
        burned = _executePairRoute(pairAsset, amountIn, minNativeOut, minPonsbotOut, deadline);
    }

    function _executePairRoute(address pairAsset, uint256 amountIn, uint256 minNativeOut, uint256 minPonsbotOut, uint256 deadline)
        private returns (uint256 burned)
    {
        uint256 ponsBefore = IERC20PairedBuybackExecutor(canonicalPonsbot).balanceOf(address(this));
        uint256 nativeOut = _pairToNative(pairAsset, amountIn, minNativeOut, deadline);
        _nativeToPons(nativeOut, minPonsbotOut, deadline);
        burned = IERC20PairedBuybackExecutor(canonicalPonsbot).balanceOf(address(this)) - ponsBefore;
        if (burned < minPonsbotOut) revert BuybackVerificationFailed();
        _safeTransfer(canonicalPonsbot, BURN_ADDRESS, burned);
        _safeApprove(pairAsset, permit2, 0);
        IPermit2PairedBuybackExecutor(permit2).approve(pairAsset, universalRouter, 0, 0);
    }

    function _pairToNative(address pairAsset, uint256 amountIn, uint256 minimum, uint256 deadline)
        private returns (uint256 nativeOut)
    {
        uint256 pairBefore = IERC20PairedBuybackExecutor(pairAsset).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        PairRoute memory route = pairRoutes[pairAsset];
        if (route.kind == PairRouteKind.V3Direct) {
            _safeApprove(pairAsset, v3Router, 0);
            _safeApprove(pairAsset, v3Router, amountIn);
            uint256 wethBefore = IWethPairedBuybackExecutor(weth).balanceOf(address(this));
            uint256 amountOut = IV3RouterPairedBuybackExecutor(v3Router).exactInputSingle(
                IV3RouterPairedBuybackExecutor.ExactInputSingleParams({
                    tokenIn: pairAsset, tokenOut: weth, fee: route.fee, recipient: address(this), amountIn: amountIn,
                    amountOutMinimum: minimum, sqrtPriceLimitX96: 0
                })
            );
            if (amountOut < minimum || IWethPairedBuybackExecutor(weth).balanceOf(address(this)) - wethBefore != amountOut) {
                revert BuybackVerificationFailed();
            }
            IWethPairedBuybackExecutor(weth).withdraw(amountOut);
            _safeApprove(pairAsset, v3Router, 0);
        } else if (route.kind == PairRouteKind.V4Direct) {
            if (route.hook != address(0) && route.hook.codehash != route.hookCodeHash) revert InvalidConfiguration();
            _safeApprove(pairAsset, permit2, 0); _safeApprove(pairAsset, permit2, amountIn);
            IPermit2PairedBuybackExecutor(permit2).approve(
                pairAsset, universalRouter, uint160(amountIn), uint48(block.timestamp + 10 minutes)
            );
            _swap(pairAsset, NATIVE_ASSET, route.fee, route.tickSpacing, false, amountIn, minimum, 0, deadline, route.hook);
        } else {
            revert InvalidConfiguration();
        }
        nativeOut = address(this).balance - nativeBefore;
        if (nativeOut < minimum || IERC20PairedBuybackExecutor(pairAsset).balanceOf(address(this)) != pairBefore - amountIn) revert BuybackVerificationFailed();
    }

    function _nativeToPons(uint256 amountIn, uint256 minimum, uint256 deadline) private {
        IPonsFactoryPairedBuybackExecutor.LaunchedToken memory p = IPonsFactoryPairedBuybackExecutor(ponsFactory).getLaunchedToken(canonicalPonsbot);
        if (
            !p.exists || p.token != canonicalPonsbot || p.pairToken != NATIVE_ASSET || p.phase != 2
                || p.poolFee != canonicalPoolFee || p.tickSpacing != canonicalTickSpacing
        ) revert InvalidConfiguration();
        uint256 nativeBefore = address(this).balance;
        _swap(NATIVE_ASSET, canonicalPonsbot, p.poolFee, p.tickSpacing, true, amountIn, minimum, amountIn, deadline, canonicalHook);
        if (address(this).balance != nativeBefore - amountIn) revert BuybackVerificationFailed();
    }

    function _swap(address input, address output, uint24 fee, int24 spacing, bool zeroForOne,
        uint256 amountIn, uint256 minimum, uint256 value, uint256 deadline, address hook) private {
        PoolKey memory key = PoolKey(NATIVE_ASSET, input == NATIVE_ASSET ? output : input, fee, spacing, hook);
        ExactInputSingleParams memory swap = ExactInputSingleParams(key, zeroForOne, uint128(amountIn), uint128(minimum), 0, bytes(""));
        bytes[] memory parameters = new bytes[](3);
        parameters[0] = abi.encode(swap); parameters[1] = abi.encode(output, minimum); parameters[2] = abi.encode(input, amountIn);
        bytes[] memory inputs = new bytes[](1); inputs[0] = abi.encode(V4_ACTIONS, parameters);
        IUniversalRouterPairedBuybackExecutor(universalRouter).execute{value: value}(V4_SWAP_COMMAND, inputs, deadline);
    }

    function _safeApprove(address asset, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20PairedBuybackExecutor.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
    function _safeTransfer(address asset, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20PairedBuybackExecutor.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
    function _safeTransferFrom(address asset, address sender, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) = asset.call(
            abi.encodeCall(IERC20PairedBuybackExecutor.transferFrom, (sender, recipient, amount))
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
