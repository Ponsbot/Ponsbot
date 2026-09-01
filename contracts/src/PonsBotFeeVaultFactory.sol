// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PonsBotFeeVault.sol";

contract PonsBotFeeVaultFactory {
    address public immutable implementation;
    address public immutable feeControl;
    address public immutable ponsFactory;
    address public immutable feeEscrow;
    address public immutable ponsbot;
    mapping(address ponsFactoryAddress => address approvedEscrow) public approvedFeeEscrow;
    mapping(address token => address vault) public vaultOf;
    mapping(address vault => bool recognized) public isVault;

    event VaultDeployed(address indexed token, address indexed vault, address indexed controller, bytes32 salt);
    event PonsStackUpdated(address indexed ponsFactory, address indexed feeEscrow, bool allowed);

    error Unauthorized();
    error InvalidConfiguration();
    error VaultAlreadyExists();
    error DeploymentFailed();

    constructor(
        address implementation_,
        address feeControl_,
        address ponsFactory_,
        address feeEscrow_,
        address ponsbot_
    ) {
        if (
            implementation_ == address(0) || feeControl_ == address(0) || ponsFactory_ == address(0)
                || feeEscrow_ == address(0) || ponsbot_ == address(0)
        ) revert InvalidConfiguration();
        if (
            implementation_.code.length == 0 || feeControl_.code.length == 0 || ponsFactory_.code.length == 0
                || feeEscrow_.code.length == 0 || ponsbot_.code.length == 0
        ) revert InvalidConfiguration();
        implementation = implementation_;
        feeControl = feeControl_;
        ponsFactory = ponsFactory_;
        feeEscrow = feeEscrow_;
        ponsbot = ponsbot_;
        approvedFeeEscrow[ponsFactory_] = feeEscrow_;
    }

    function deployVault(bytes32 salt, PonsBotFeeVault.Initialization calldata init) external returns (address vault) {
        if (msg.sender != IPonsBotFeeControl(feeControl).admin()) revert Unauthorized();
        if (vaultOf[init.token] != address(0)) revert VaultAlreadyExists();
        if (
            init.feeControl != feeControl || approvedFeeEscrow[init.ponsFactory] != init.feeEscrow
                || init.ponsbot != ponsbot
        ) revert InvalidConfiguration();
        vault = _cloneDeterministic(implementation, salt);
        PonsBotFeeVault(payable(vault)).initialize(init);
        vaultOf[init.token] = vault;
        isVault[vault] = true;
        emit VaultDeployed(init.token, vault, init.controller, salt);
    }

    /// @notice Allows one deployment to serve launches tied to an older or
    /// newer Pons stack. The exact factory/escrow pair is approved on-chain and
    /// can only change while every vault is globally paused.
    function setPonsStack(address ponsFactoryAddress, address escrowAddress, bool allowed) external {
        IPonsBotFeeControl control = IPonsBotFeeControl(feeControl);
        if (msg.sender != control.admin()) revert Unauthorized();
        if (control.processingEnabled()) revert InvalidConfiguration();
        if (
            ponsFactoryAddress == address(0) || ponsFactoryAddress.code.length == 0
                || (allowed && (escrowAddress == address(0) || escrowAddress.code.length == 0))
        ) revert InvalidConfiguration();
        approvedFeeEscrow[ponsFactoryAddress] = allowed ? escrowAddress : address(0);
        emit PonsStackUpdated(ponsFactoryAddress, escrowAddress, allowed);
    }

    function predictVaultAddress(bytes32 salt) external view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(_cloneCreationCode(implementation));
        predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash)))));
    }

    function _cloneDeterministic(address target, bytes32 salt) private returns (address instance) {
        bytes memory creationCode = _cloneCreationCode(target);
        assembly ("memory-safe") {
            instance := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (instance == address(0)) revert DeploymentFailed();
    }

    function _cloneCreationCode(address target) private pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73", target, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
