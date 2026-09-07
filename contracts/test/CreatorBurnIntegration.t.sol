// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./AutomatedFees.t.sol";
import "./CreatorBurnExecutor.t.sol";
import "../src/PonsBotCreatorBurnVaultFactory.sol";

contract CIHolderRegistry {
    address public destination;
    function set(address a) external {destination=a;}
    function distributorOf(address) external view returns(address) {return destination;}
}

/// @dev Real primary vault, adapter, control, both factories, layer and executor.
/// External Pons escrow/curve/router and tokens remain deterministic test doubles.
contract CreatorBurnIntegrationTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant KEEPER=address(0xbeef);
    address constant NEXT=address(0x123);
    address constant DEAD=0x000000000000000000000000000000000000dEaD;
    PonsBotFeeControl control;
    PonsBotFeeVault primary;
    PonsBotCreatorBurnVault layer;
    PonsBotCreatorBurnVaultFactory layers;
    PonsBotCreatorBurnExecutor executor;
    MockEscrow escrow;
    MockPonsFactory pons;
    MockToken token;
    MockToken pair;
    MockToken ponsbot;
    MockRouter buyback;
    CIHolderRegistry holders;
    CECurve curve;
    receive() external payable {}
    function setUp() public {
        vm.deal(address(this),100 ether);
        token=new MockToken();pair=new MockToken();ponsbot=new MockToken();escrow=new MockEscrow();pons=new MockPonsFactory();
        control=new PonsBotFeeControl(address(this),address(0xcafe),KEEPER,vm.addr(42));
        PonsBotFeeVaultFactory primaryFactory=new PonsBotFeeVaultFactory(address(new PonsBotFeeVault()),address(control),address(pons),address(escrow),address(ponsbot));
        PonsBotBuybackAdapter adapter=new PonsBotBuybackAdapter(address(primaryFactory),address(control),address(ponsbot));
        buyback=new MockRouter();control.setExecutionAdapter(address(adapter));adapter.setExecutor(address(buyback),true);control.enableProcessing();
        curve=new CECurve(CEToken(address(token)),address(pair));
        address predicted=primaryFactory.predictVaultAddress(bytes32(uint256(1)));
        pons.setLaunch(address(token),address(curve),predicted,address(pair),0);
        PonsBotFeeVault.Initialization memory init=PonsBotFeeVault.Initialization(address(token),address(curve),address(pair),address(pons),address(escrow),address(ponsbot),address(this),address(this),address(control));
        primary=PonsBotFeeVault(payable(primaryFactory.deployVault(bytes32(uint256(1)),init)));
        CEPermit permit=new CEPermit();
        executor=new PonsBotCreatorBurnExecutor(address(this),address(pons),address(new CERouter(permit)),address(permit));
        holders=new CIHolderRegistry();
        layers=new PonsBotCreatorBurnVaultFactory(address(primaryFactory),address(control),address(executor),address(holders));
        executor.bindRegistry(address(layers));
        layer=PonsBotCreatorBurnVault(payable(layers.create(address(primary))));
    }
    function auth() private returns(PonsBotFeeVault.ExecutionAuthorization memory a) {
        a.maxBuybackAmount=1 ether;a.minPonsbotOut=1;a.deadline=block.timestamp+100;a.routeTarget=address(buyback);a.routeData=abi.encode(uint256(100));
        bytes32 digest=primary.executionAuthorizationDigest(a.maxBuybackAmount,a.minPonsbotOut,0,a.deadline,a.routeTarget,keccak256(a.routeData),primary.executionNonce());
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(42,digest);a.quoteSignature=abi.encodePacked(r,s,v);
    }
    function enroll() private {
        vm.prank(KEEPER);primary.sweepCurveFees(0);
        primary.settleAndReassign(address(layer),address(layer),auth());layer.setPercentage(5000);
    }
    function credit() private {pair.mint(address(this),1 ether);pair.approve(address(escrow),1 ether);escrow.creditToken(address(primary),address(pair),1 ether);}
    function process() private {
        vm.prank(KEEPER);primary.sweepCurveFees(0);PonsBotFeeVault.ExecutionAuthorization memory a=auth();vm.prank(KEEPER);primary.processFees(a);
    }
    function burnSignature() private returns(bytes memory) {
        bytes32 digest=layer.burnDigest(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,keccak256(abi.encode(uint8(0))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(42,digest);return abi.encodePacked(r,s,v);
    }
    function testCreationIsDormantAndDoesNotTransferControl() public {require(!layer.active());require(primary.controller()==address(this));}
    function testCollectAndPayImmediatelyBeforeAnySelfBurn() public {
        enroll();credit();process();curve.setFail(true);layer.collectAndPay();
        require(pair.balanceOf(address(this))==0.475 ether&&layer.payableTo(address(this))==0);
        require(layer.burnReserve(address(this))==0.475 ether&&token.balanceOf(DEAD)==0);
        require(primary.claimable(address(layer),address(pair))==0);
        layer.collectAndPay();require(pair.balanceOf(address(this))==0.475 ether);
    }
    function testHundredPercentCollectAndPayHasNoCashTransfer() public {
        enroll();layer.setPercentage(10000);credit();process();layer.collectAndPay();
        require(layer.burnReserve(address(this))==0.95 ether&&layer.payableTo(address(this))==0);
        require(pair.balanceOf(address(this))==0);
    }
    function testRealPairedCycleFiveFortySevenPointFiveFortySevenPointFive() public {
        enroll();credit();process();layer.collect();
        require(primary.lifetimeBuybackSpent(address(pair))==0.05 ether);
        require(layer.payableTo(address(this))==0.475 ether&&layer.burnReserve(address(this))==0.475 ether);
        bytes memory sig=burnSignature();vm.prank(KEEPER);
        layer.executeBurn(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,abi.encode(uint8(0)),sig);
        require(token.balanceOf(DEAD)==0.95 ether);layer.withdrawFor(address(this));
        require(pair.balanceOf(address(this))==0.475 ether&&layer.accounted()==0);
    }
    function testDirectKeeperDeliveryThenCollectNoDoubleCount() public {
        enroll();credit();process();vm.prank(KEEPER);primary.deliverBeneficiaryAllocation(address(layer),address(pair),0.95 ether);
        layer.collect();layer.collect();require(layer.accounted()==0.95 ether&&layer.burnReserve(address(this))==0);
        require(layer.payableTo(address(this))==0.95 ether);
    }
    function testPreEnrollmentFeesRemainWithOriginalWallet() public {
        credit();enroll();require(primary.claimable(address(this),address(pair))==0.95 ether);require(layer.accounted()==0);
    }
    function testRealEmergencyExitAndOutstandingFeesRecoverable() public {
        enroll();credit();layer.emergencyExitToOwner();require(pons.recipientOf(address(token))==address(this));
        require(layer.exited()&&!primary.active());layer.releaseReserve(0.5 ether);layer.withdrawFor(address(this));require(pair.balanceOf(address(this))==1 ether);
    }
    function testNewOwnerControlsRealUpstreamExit() public {
        enroll();layer.reassign(NEXT);vm.prank(NEXT);layer.emergencyExitToOwner();require(pons.recipientOf(address(token))==NEXT);
    }
    function testDetachKeepsPrimaryActiveAndReturnsControl() public {
        enroll();vm.prank(KEEPER);primary.sweepCurveFees(0);layer.detach(auth());require(primary.active()&&primary.controller()==address(this)&&layer.exited());
    }
    function testOldReserveCannotBeTakenByNewOwner() public {
        enroll();credit();process();layer.reassign(NEXT);vm.prank(NEXT);
        (bool ok,)=address(layer).call(abi.encodeCall(layer.releaseReserve,(0.475 ether)));require(!ok);
        layer.releaseReserve(0.475 ether);layer.withdrawFor(address(this));require(pair.balanceOf(address(this))==0.95 ether);
    }
    function testReplayedBurnAuthorizationRejected() public {
        enroll();credit();process();layer.collect();bytes memory sig=burnSignature();vm.prank(KEEPER);
        layer.executeBurn(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,abi.encode(uint8(0)),sig);
        credit();process();layer.collect();vm.prank(KEEPER);
        (bool ok,)=address(layer).call(abi.encodeCall(layer.executeBurn,(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,abi.encode(uint8(0)),sig)));require(!ok);
    }
    function testFactoryRejectsOutsider() public {
        vm.prank(NEXT);(bool ok,)=address(layers).call(abi.encodeCall(layers.create,(address(primary))));require(!ok);
    }
    function testBadSignaturePreservesReserve() public {
        enroll();credit();process();layer.collect();bytes memory sig=new bytes(65);vm.prank(KEEPER);
        (bool ok,)=address(layer).call(abi.encodeCall(layer.executeBurn,(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,abi.encode(uint8(0)),sig)));require(!ok&&layer.burnReserve(address(this))==0.475 ether);
    }

    function testDormantOwnerFollowsActualPrimaryReassignment() public {
        vm.prank(KEEPER);primary.sweepCurveFees(0);
        primary.settleAndReassign(NEXT,NEXT,auth());
        layers.syncDormantOwner(address(primary));
        require(layer.owner()==NEXT&&!layer.active());
        (bool ok,)=address(layer).call(abi.encodeCall(layer.setPercentage,(5000)));require(!ok);
    }
    function testOutsiderSyncCannotChooseOwner() public {
        vm.prank(NEXT);layers.syncDormantOwner(address(primary));require(layer.owner()==address(this));
    }
    function testActiveLayerCannotResyncToPrimaryAddress() public {
        enroll();(bool ok,)=address(layer).call(abi.encodeCall(layer.syncDormantOwner,()));require(!ok);
    }
    function testReplaceDetachedLayerPreservesOldBalances() public {
        enroll();credit();process();layer.collect();
        vm.prank(KEEPER);primary.sweepCurveFees(0);layer.detach(auth());
        PonsBotCreatorBurnVault replacement=PonsBotCreatorBurnVault(payable(layers.create(address(primary))));
        require(address(replacement)!=address(layer)&&replacement.owner()==address(this));
        require(layers.isLayer(address(layer))&&layers.layerOf(address(primary))==address(replacement));
        layer.releaseReserve(0.475 ether);layer.withdrawFor(address(this));require(pair.balanceOf(address(this))==0.95 ether);
    }
    function testActiveLayerCannotBeReplaced() public {
        enroll();(bool ok,)=address(layers).call(abi.encodeCall(layers.create,(address(primary))));require(!ok);
    }
    function testDonationsAreCashNotCreatorFeesOrBurnReserve() public {
        enroll();pair.mint(address(layer),2 ether);credit();process();layer.collect();
        require(layer.burnReserve(address(this))==0.475 ether&&layer.payableTo(address(this))==2.475 ether);
    }
    function testExpiredAndLongLivedQuotesRejected() public {
        enroll();credit();process();layer.collect();bytes memory sig=burnSignature();
        vm.prank(KEEPER);(bool ok,)=address(layer).call(abi.encodeCall(layer.executeBurn,(address(this),0.475 ether,1,block.timestamp,block.timestamp+601,abi.encode(uint8(0)),sig)));require(!ok);
        vm.prank(KEEPER);(ok,)=address(layer).call(abi.encodeCall(layer.executeBurn,(address(this),0.475 ether,1,block.timestamp+1,block.timestamp+100,abi.encode(uint8(0)),sig)));require(!ok);
    }
    function testCashWithdrawSucceedsEvenIfCurveBuyFails() public {
        enroll();credit();process();layer.collect();curve.setFail(true);bytes memory sig=burnSignature();
        vm.prank(KEEPER);(bool ok,)=address(layer).call(abi.encodeCall(layer.executeBurn,(address(this),0.475 ether,1,block.timestamp,block.timestamp+100,abi.encode(uint8(0)),sig)));require(!ok);
        layer.withdrawFor(address(this));require(pair.balanceOf(address(this))==0.475 ether&&layer.burnReserve(address(this))==0.475 ether);
    }
}
