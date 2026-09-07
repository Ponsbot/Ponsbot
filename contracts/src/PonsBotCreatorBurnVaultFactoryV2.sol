// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PonsBotCreatorBurnVaultV2.sol";

interface ICreatorPrimaryRegistryV2 { function isVault(address candidate) external view returns (bool); }

/// @notice New-launch-only deterministic creator-layer registry. Existing
/// upgrade layers remain registered in the original factory.
contract PonsBotCreatorBurnVaultFactoryV2 {
    address public immutable primaryFactory;
    address public immutable feeControl;
    address public immutable executor;
    address public immutable holderRegistry;
    mapping(address => address) public layerOf;
    mapping(address => bool) public isLayer;

    event LayerCreated(address indexed primary, address indexed layer, address indexed owner, uint16 selfBurnBps, bytes32 salt);
    error Unauthorized();
    error InvalidConfiguration();

    constructor(address primaryFactory_, address feeControl_, address executor_, address holderRegistry_) {
        if (primaryFactory_.code.length == 0 || feeControl_.code.length == 0
            || executor_.code.length == 0 || holderRegistry_.code.length == 0) revert InvalidConfiguration();
        primaryFactory = primaryFactory_;
        feeControl = feeControl_;
        executor = executor_;
        holderRegistry = holderRegistry_;
    }

    function predictLayerAddress(address primary, address owner, uint16 selfBurnBps, bytes32 salt)
        public view returns (address predicted)
    {
        bytes32 hash = keccak256(abi.encodePacked(
            type(PonsBotCreatorBurnVaultV2).creationCode,
            abi.encode(primary, owner, executor, holderRegistry, selfBurnBps)
        ));
        predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, hash)))));
    }

    function create(address primary, address owner, uint16 selfBurnBps, bytes32 salt)
        external returns (address layer)
    {
        if (msg.sender != IPonsBotFeeControl(feeControl).admin()) revert Unauthorized();
        if (owner == address(0) || selfBurnBps > 10_000 || layerOf[primary] != address(0)
            || !ICreatorPrimaryRegistryV2(primaryFactory).isVault(primary)
            || PonsBotFeeVault(payable(primary)).feeControl() != feeControl) revert InvalidConfiguration();
        layer = address(new PonsBotCreatorBurnVaultV2{salt: salt}(
            primary, owner, executor, holderRegistry, selfBurnBps
        ));
        if (layer != predictLayerAddress(primary, owner, selfBurnBps, salt)
            || PonsBotFeeVault(payable(primary)).controller() != layer
            || PonsBotFeeVault(payable(primary)).beneficiary() != layer) revert InvalidConfiguration();
        layerOf[primary] = layer;
        isLayer[layer] = true;
        emit LayerCreated(primary, layer, owner, selfBurnBps, salt);
    }
}
