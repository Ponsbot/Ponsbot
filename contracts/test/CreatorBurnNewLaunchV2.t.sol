// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AutomatedFees.t.sol";
import "./CreatorBurnExecutor.t.sol";
import "../src/PonsBotCreatorBurnVaultFactoryV2.sol";

contract V2HolderRegistry {
    function distributorOf(address) external pure returns (address) { return address(0); }
}

/// @dev Proves that a new launch can bind both vaults before deployment. No
/// post-launch controller transaction exists in this lifecycle.
contract CreatorBurnNewLaunchV2Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant KEEPER = address(0xbeef);
    address constant OWNER = address(0x1234);

    PonsBotFeeControl control;
    PonsBotFeeVaultFactory primaryFactory;
    PonsBotCreatorBurnVaultFactoryV2 layerFactory;
    PonsBotCreatorBurnExecutor executor;
    MockEscrow escrow;
    MockPonsFactory pons;
    MockToken token;
    MockToken pair;
    MockToken ponsbot;

    function setUp() public {
        token = new MockToken(); pair = new MockToken(); ponsbot = new MockToken();
        escrow = new MockEscrow(); pons = new MockPonsFactory();
        control = new PonsBotFeeControl(address(this), address(0xcafe), KEEPER, vm.addr(42));
        primaryFactory = new PonsBotFeeVaultFactory(
            address(new PonsBotFeeVault()), address(control), address(pons), address(escrow), address(ponsbot)
        );
        CEPermit permit = new CEPermit();
        executor = new PonsBotCreatorBurnExecutor(address(this), address(pons), address(new CERouter(permit)), address(permit));
        layerFactory = new PonsBotCreatorBurnVaultFactoryV2(
            address(primaryFactory), address(control), address(executor), address(new V2HolderRegistry())
        );
        executor.bindRegistry(address(layerFactory));
    }

    function testNewLaunchIsPreboundAndConfiguredWithoutReassignment() public {
        bytes32 primarySalt = bytes32(uint256(1));
        bytes32 layerSalt = bytes32(uint256(2));
        address primaryAddress = primaryFactory.predictVaultAddress(primarySalt);
        address layerAddress = layerFactory.predictLayerAddress(primaryAddress, OWNER, 5000, layerSalt);
        CECurve curve = new CECurve(CEToken(address(token)), address(pair));
        pons.setLaunch(address(token), address(curve), primaryAddress, address(pair), 0);

        PonsBotFeeVault.Initialization memory init = PonsBotFeeVault.Initialization(
            address(token), address(curve), address(pair), address(pons), address(escrow), address(ponsbot),
            layerAddress, layerAddress, address(control)
        );
        address primary = primaryFactory.deployVault(primarySalt, init);
        address layer = layerFactory.create(primary, OWNER, 5000, layerSalt);

        require(primary == primaryAddress && layer == layerAddress);
        require(PonsBotFeeVault(payable(primary)).controller() == layer);
        require(PonsBotFeeVault(payable(primary)).beneficiary() == layer);
        require(PonsBotCreatorBurnVault(payable(layer)).owner() == OWNER);
        require(PonsBotCreatorBurnVault(payable(layer)).selfBurnBps() == 5000);
        require(PonsBotCreatorBurnVault(payable(layer)).active());
        require(layerFactory.layerOf(primary) == layer && layerFactory.isLayer(layer));
    }

    function testOnlyAdminCanCreatePreboundLayer() public {
        bytes32 primarySalt = bytes32(uint256(3));
        bytes32 layerSalt = bytes32(uint256(4));
        address primaryAddress = primaryFactory.predictVaultAddress(primarySalt);
        address layerAddress = layerFactory.predictLayerAddress(primaryAddress, OWNER, 0, layerSalt);
        CECurve curve = new CECurve(CEToken(address(token)), address(pair));
        pons.setLaunch(address(token), address(curve), primaryAddress, address(pair), 0);
        PonsBotFeeVault.Initialization memory init = PonsBotFeeVault.Initialization(
            address(token), address(curve), address(pair), address(pons), address(escrow), address(ponsbot),
            layerAddress, layerAddress, address(control)
        );
        primaryFactory.deployVault(primarySalt, init);
        vm.prank(address(0xbad));
        (bool ok,) = address(layerFactory).call(abi.encodeCall(layerFactory.create, (primaryAddress, OWNER, 0, layerSalt)));
        require(!ok);
    }

    function testWrongPredictedOwnerOrPercentageCannotDeploy() public {
        bytes32 primarySalt = bytes32(uint256(5));
        bytes32 layerSalt = bytes32(uint256(6));
        address primaryAddress = primaryFactory.predictVaultAddress(primarySalt);
        address expectedLayer = layerFactory.predictLayerAddress(primaryAddress, OWNER, 5000, layerSalt);
        CECurve curve = new CECurve(CEToken(address(token)), address(pair));
        pons.setLaunch(address(token), address(curve), primaryAddress, address(pair), 0);
        primaryFactory.deployVault(primarySalt, PonsBotFeeVault.Initialization(
            address(token), address(curve), address(pair), address(pons), address(escrow), address(ponsbot),
            expectedLayer, expectedLayer, address(control)
        ));
        (bool ok,) = address(layerFactory).call(abi.encodeCall(layerFactory.create, (primaryAddress, OWNER, 4999, layerSalt)));
        require(!ok && layerFactory.layerOf(primaryAddress) == address(0));
    }
}
