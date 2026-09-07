// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PonsBotCreatorBurnVault.sol";

interface ICreatorPrimaryRegistry { function isVault(address candidate) external view returns (bool); }

/// @notice Separate opt-in registry; never changes the deployed primary factory.
contract PonsBotCreatorBurnVaultFactory {
    address public immutable primaryFactory;
    address public immutable feeControl;
    address public immutable executor;
    address public immutable holderRegistry;
    mapping(address => address) public layerOf;
    mapping(address => bool) public isLayer;
    event LayerCreated(address indexed primary, address indexed layer, address indexed owner);
    error Unauthorized();
    error InvalidConfiguration();

    constructor(address primaryFactory_, address feeControl_, address executor_, address holderRegistry_) {
        if (primaryFactory_.code.length == 0 || feeControl_.code.length == 0
            || executor_.code.length == 0 || holderRegistry_.code.length == 0) revert InvalidConfiguration();
        primaryFactory = primaryFactory_; feeControl = feeControl_; executor = executor_; holderRegistry = holderRegistry_;
    }

    function create(address primary) external returns (address layer) {
        if (msg.sender != IPonsBotFeeControl(feeControl).admin()) revert Unauthorized();
        if (!ICreatorPrimaryRegistry(primaryFactory).isVault(primary) || layerOf[primary] != address(0)
            || PonsBotFeeVault(payable(primary)).feeControl() != feeControl) revert InvalidConfiguration();
        address controller = PonsBotFeeVault(payable(primary)).controller();
        layer = address(new PonsBotCreatorBurnVault(primary, controller, executor, holderRegistry));
        layerOf[primary] = layer; isLayer[layer] = true;
        emit LayerCreated(primary, layer, controller);
        // Creating a layer NEVER assigns fee rights. The controller must separately opt in.
    }
}
