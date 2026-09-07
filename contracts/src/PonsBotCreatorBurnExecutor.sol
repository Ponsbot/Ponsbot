// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PonsBotNativeBuybackExecutor.sol";

interface ICreatorExecutorRegistry {
    function isLayer(address) external view returns (bool);
    function layerOf(address) external view returns (address);
    function executor() external view returns (address);
}
interface ICreatorExecutorLayer {
    function upstream() external view returns (address);
    function token() external view returns (address);
    function asset() external view returns (address);
    function active() external view returns (bool);
}
interface ICreatorExecutorToken {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface ICreatorExecutorCurve {
    function buy(uint256, uint256, address) external payable returns (uint256);
}
interface ICreatorExecutorPermit2 {
    function approve(address, address, uint160, uint48) external;
}

/// @notice Only buys a registered layer's own token using its canonical Pons pair.
/// No arbitrary calldata, intermediate assets, or caller-selected destinations.
contract PonsBotCreatorBurnExecutor {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable deploymentAdmin;
    address public immutable ponsFactory;
    address public immutable router;
    address public immutable permit2;
    address public immutable hook;
    bytes32 public immutable factoryHash;
    bytes32 public immutable routerHash;
    bytes32 public immutable permitHash;
    bytes32 public immutable hookHash;
    address public registry;
    bytes32 public registryHash;
    bool private entered;
    error Unauthorized();
    error InvalidRoute();
    error TransferFailed();
    error VerificationFailed();
    event RegistryBound(address indexed registry);
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct Swap { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }

    constructor(address admin, address factory, address universalRouter, address permit) {
        if (admin == address(0) || factory.code.length == 0 || universalRouter.code.length == 0
            || permit.code.length == 0) revert InvalidRoute();
        address h = IPonsFactoryNativeBuybackExecutor(factory).memeHook();
        if (h.code.length == 0) revert InvalidRoute();
        deploymentAdmin = admin; ponsFactory = factory; router = universalRouter; permit2 = permit; hook = h;
        factoryHash = factory.codehash; routerHash = universalRouter.codehash; permitHash = permit.codehash; hookHash = h.codehash;
    }

    /// @dev One-time binding breaks deployment circularity. Unbound executor cannot run.
    function bindRegistry(address candidate) external {
        if (msg.sender != deploymentAdmin || registry != address(0)) revert Unauthorized();
        if (candidate.code.length == 0 || ICreatorExecutorRegistry(candidate).executor() != address(this)) revert InvalidRoute();
        registry = candidate; registryHash = candidate.codehash;
        emit RegistryBound(candidate);
    }

    receive() external payable {}

    function buyAndBurn(address asset, address token, uint256 amount, uint256 minimum, bytes calldata route)
        external payable returns (uint256 burned)
    {
        if (entered || registry == address(0) || registry.codehash != registryHash
            || !ICreatorExecutorRegistry(registry).isLayer(msg.sender)) revert Unauthorized();
        entered = true;
        ICreatorExecutorLayer layer = ICreatorExecutorLayer(msg.sender);
        if (!layer.active() || layer.token() != token || layer.asset() != asset
            || ICreatorExecutorRegistry(registry).layerOf(layer.upstream()) != msg.sender) revert Unauthorized();
        if (amount == 0 || minimum == 0 || amount > type(uint128).max || minimum > type(uint128).max
            || route.length != 32 || token == asset || msg.value != (asset == address(0) ? amount : 0)) revert InvalidRoute();
        if (ponsFactory.codehash != factoryHash || router.codehash != routerHash || permit2.codehash != permitHash
            || hook.codehash != hookHash || IPonsFactoryNativeBuybackExecutor(ponsFactory).memeHook() != hook) revert InvalidRoute();
        IPonsFactoryNativeBuybackExecutor.LaunchedToken memory launched =
            IPonsFactoryNativeBuybackExecutor(ponsFactory).getLaunchedToken(token);
        // Pin the quoted phase so a graduation race requires a new quote.
        if (!launched.exists || launched.token != token || launched.pairToken != asset
            || launched.phase != abi.decode(route, (uint8)) || (launched.phase != 0 && launched.phase != 2)) revert InvalidRoute();
        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 assetBefore = asset == address(0) ? nativeBefore : ICreatorExecutorToken(asset).balanceOf(address(this));
        uint256 tokenBefore = ICreatorExecutorToken(token).balanceOf(address(this));
        if (asset != address(0)) {
            _call(asset, abi.encodeCall(ICreatorExecutorToken.transferFrom, (msg.sender, address(this), amount)));
            if (ICreatorExecutorToken(asset).balanceOf(address(this)) != assetBefore + amount) revert VerificationFailed();
        }
        if (launched.phase == 0) _curve(launched.curve, asset, amount, minimum);
        else _graduated(launched, asset, amount, minimum);
        if (address(this).balance != nativeBefore || (asset != address(0)
            && ICreatorExecutorToken(asset).balanceOf(address(this)) != assetBefore)) revert VerificationFailed();
        uint256 received = ICreatorExecutorToken(token).balanceOf(address(this)) - tokenBefore;
        uint256 deadBefore = ICreatorExecutorToken(token).balanceOf(DEAD);
        _call(token, abi.encodeCall(ICreatorExecutorToken.transfer, (DEAD, received)));
        burned = ICreatorExecutorToken(token).balanceOf(DEAD) - deadBefore;
        if (burned < minimum || ICreatorExecutorToken(token).balanceOf(address(this)) != tokenBefore) revert VerificationFailed();
        entered = false;
    }

    function _curve(address curve, address asset, uint256 amount, uint256 minimum) private {
        if (curve.code.length == 0) revert InvalidRoute();
        if (asset != address(0)) _approve(asset, curve, amount);
        ICreatorExecutorCurve(curve).buy{value: asset == address(0) ? amount : 0}(amount, minimum, address(this));
        if (asset != address(0)) _approve(asset, curve, 0);
    }

    function _graduated(IPonsFactoryNativeBuybackExecutor.LaunchedToken memory launched, address asset, uint256 amount, uint256 minimum) private {
        if (launched.tickSpacing <= 0) revert InvalidRoute();
        bool zeroForOne = asset < launched.token;
        PoolKey memory key = PoolKey(zeroForOne ? asset : launched.token, zeroForOne ? launched.token : asset,
            launched.poolFee, launched.tickSpacing, hook);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(Swap(key, zeroForOne, uint128(amount), uint128(minimum), 0, bytes("")));
        params[1] = abi.encode(launched.token, minimum);
        params[2] = abi.encode(asset, amount);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060f0c", params);
        if (asset != address(0)) {
            _approve(asset, permit2, amount);
            ICreatorExecutorPermit2(permit2).approve(asset, router, uint160(amount), uint48(block.timestamp));
        }
        IUniversalRouterNativeBuybackExecutor(router).execute{value: asset == address(0) ? amount : 0}(hex"10", inputs, block.timestamp);
        if (asset != address(0)) {
            ICreatorExecutorPermit2(permit2).approve(asset, router, 0, 0);
            _approve(asset, permit2, 0);
        }
    }

    function _approve(address token, address spender, uint256 amount) private {
        _call(token, abi.encodeCall(ICreatorExecutorToken.approve, (spender, 0)));
        if (amount != 0) _call(token, abi.encodeCall(ICreatorExecutorToken.approve, (spender, amount)));
    }
    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
