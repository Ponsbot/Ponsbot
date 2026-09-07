// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/PonsBotCreatorBurnExecutor.sol";

interface CreatorExecVm { function deal(address, uint256) external; function prank(address) external; }
contract CEToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address a, uint256 n) external returns(bool) { allowance[msg.sender][a] = n; return true; }
    function transfer(address a, uint256 n) external returns(bool) { balanceOf[msg.sender] -= n; balanceOf[a] += n; return true; }
    function transferFrom(address a, address b, uint256 n) external returns(bool) {
        allowance[a][msg.sender] -= n; balanceOf[a] -= n; balanceOf[b] += n; return true;
    }
}
contract CECurve {
    CEToken public token; address public asset; bool public fail;
    constructor(CEToken t, address a) { token=t; asset=a; }
    function setFail(bool v) external { fail=v; }
    function sweepFees(uint256) external {}
    function buy(uint256 n, uint256, address to) external payable returns(uint256) {
        require(!fail);
        if(asset==address(0)) require(msg.value==n);
        else require(CEToken(asset).transferFrom(msg.sender,address(this),n));
        token.mint(to,n*2); return n*2;
    }
}
contract CEFactory {
    address public memeHook;
    IPonsFactoryNativeBuybackExecutor.LaunchedToken private launched;
    constructor() { memeHook=address(new CEToken()); }
    function configure(address token,address curve,address pair,uint8 phase) external {
        launched.token=token; launched.curve=curve; launched.pairToken=pair; launched.phase=phase;
        launched.tickSpacing=200; launched.exists=true;
    }
    function getLaunchedToken(address) external view returns(IPonsFactoryNativeBuybackExecutor.LaunchedToken memory) { return launched; }
}
contract CERegistry {
    address public executor;
    mapping(address=>bool) public isLayer;
    mapping(address=>address) public layerOf;
    constructor(address e) {executor=e;}
    function register(address layer) external {isLayer[layer]=true; layerOf[layer]=layer;}
}
contract CEPermit {
    mapping(address=>mapping(address=>uint160)) public amount;
    function approve(address token,address spender,uint160 n,uint48) external {amount[token][spender]=n;}
    function spend(address token,address from,address to,uint256 n) external {
        require(amount[token][msg.sender]>=n); amount[token][msg.sender]-=uint160(n);
        require(CEToken(token).transferFrom(from,to,n));
    }
}
contract CERouter {
    CEPermit public permit;
    constructor(CEPermit p) {permit=p;}
    function execute(bytes calldata commands,bytes[] calldata inputs,uint256) external payable {
        require(keccak256(commands)==keccak256(hex"10"));
        (bytes memory actions,bytes[] memory params)=abi.decode(inputs[0],(bytes,bytes[]));
        require(keccak256(actions)==keccak256(hex"060f0c"));
        PonsBotCreatorBurnExecutor.Swap memory swap=abi.decode(params[0],(PonsBotCreatorBurnExecutor.Swap));
        address asset=swap.zeroForOne?swap.poolKey.currency0:swap.poolKey.currency1;
        address token=swap.zeroForOne?swap.poolKey.currency1:swap.poolKey.currency0;
        if(asset==address(0)) require(msg.value==swap.amountIn);
        else permit.spend(asset,msg.sender,address(this),swap.amountIn);
        CEToken(token).mint(msg.sender,uint256(swap.amountIn)*2);
    }
}
contract CreatorBurnExecutorTest {
    CreatorExecVm constant vm=CreatorExecVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public upstream=address(this);
    address public token;
    address public asset;
    bool public active=true;
    PonsBotCreatorBurnExecutor executor;
    CEFactory factory;
    CECurve curve;
    CEPermit permit;
    CERegistry registry;
    receive() external payable {}
    function setUp() public {
        vm.deal(address(this),10 ether);
        token=address(new CEToken()); factory=new CEFactory(); permit=new CEPermit();
        executor=new PonsBotCreatorBurnExecutor(address(this),address(factory),address(new CERouter(permit)),address(permit));
        registry=new CERegistry(address(executor)); registry.register(address(this)); executor.bindRegistry(address(registry));
        curve=new CECurve(CEToken(token),address(0)); factory.configure(token,address(curve),address(0),0);
    }
    function run(uint8 phase,uint256 minimum) external returns(uint256) {
        return executor.buyAndBurn{value:asset==address(0)?1 ether:0}(asset,token,1 ether,minimum,abi.encode(phase));
    }
    function paired(uint8 phase) private {
        asset=address(new CEToken()); CEToken(asset).mint(address(this),2 ether); CEToken(asset).approve(address(executor),1 ether);
        curve=new CECurve(CEToken(token),asset); factory.configure(token,address(curve),asset,phase);
    }
    function testNativeCurveBurn() public {require(this.run(0,1)==2 ether); require(CEToken(token).balanceOf(executor.DEAD())==2 ether);}
    function testPairedCurveBurnAndAllowanceCleared() public {
        paired(0); require(this.run(0,1)==2 ether);
        require(CEToken(asset).allowance(address(executor),address(curve))==0);
        require(CEToken(asset).balanceOf(address(executor))==0);
    }
    function testNativeGraduatedBurn() public {factory.configure(token,address(curve),asset,2);require(this.run(2,1)==2 ether);}
    function testPairedGraduatedBurnAndPermitCleared() public {
        paired(2); require(this.run(2,1)==2 ether);
        require(CEToken(asset).allowance(address(executor),address(permit))==0);
        require(permit.amount(asset,executor.router())==0);
    }
    function testPhaseChangeRejectsStaleQuote() public {
        factory.configure(token,address(curve),asset,2); (bool ok,)=address(this).call(abi.encodeCall(this.run,(0,1)));require(!ok);
    }
    function testUnregisteredCallerRejected() public {
        vm.prank(address(123)); (bool ok,)=address(executor).call(abi.encodeCall(executor.buyAndBurn,(asset,token,1,1,abi.encode(uint8(0)))));require(!ok);
    }
    function testInactiveLayerRejected() public {active=false;(bool ok,)=address(this).call(abi.encodeCall(this.run,(0,1)));require(!ok);}
    function testWrongTokenRejected() public {factory.configure(address(123),address(curve),asset,0);(bool ok,)=address(this).call(abi.encodeCall(this.run,(0,1)));require(!ok);}
    function testWrongPairRejected() public {factory.configure(token,address(curve),address(123),0);(bool ok,)=address(this).call(abi.encodeCall(this.run,(0,1)));require(!ok);}
    function testRevertedCurveDoesNotConsumeAssets() public {
        paired(0);curve.setFail(true);(bool ok,)=address(this).call(abi.encodeCall(this.run,(0,1)));require(!ok);
        require(CEToken(asset).balanceOf(address(this))==2 ether);require(CEToken(asset).allowance(address(executor),address(curve))==0);
    }
    function testMinimumEnforcedOnRealDeadDelta() public {(bool ok,)=address(this).call(abi.encodeCall(this.run,(0,3 ether)));require(!ok);require(CEToken(token).balanceOf(executor.DEAD())==0);}
    function testRegistryCannotBeRebound() public {(bool ok,)=address(executor).call(abi.encodeCall(executor.bindRegistry,(address(registry))));require(!ok);}
}
