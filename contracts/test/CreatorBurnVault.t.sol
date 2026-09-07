// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/PonsBotCreatorBurnVault.sol";

interface BurnVm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
}
contract BurnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
}
contract BurnControl {
    address public keeper;
    address public quoteAuthorizer;
    bool public processingEnabled = true;
    constructor(address k, address s) { keeper = k; quoteAuthorizer = s; }
}
contract BurnPrimary {
    address public controller;
    address public beneficiary;
    address public token;
    address public pairAsset;
    address public feeControl;
    bool public active = true;
    bool public paused;
    mapping(address => mapping(address => uint256)) public claimable;
    constructor(address t, address c) { controller = msg.sender; beneficiary = msg.sender; token = t; feeControl = c; }
    function enroll(address v) external { require(msg.sender == controller); controller = v; beneficiary = v; }
    function credit() external payable { claimable[beneficiary][address(0)] += msg.value; }
    function withdraw(address asset, address recipient, uint256 amount) external {
        require(claimable[msg.sender][asset] >= amount); claimable[msg.sender][asset] -= amount;
        (bool ok,) = recipient.call{value: amount}(""); require(ok);
    }
    function settleAndReassign(address c, address b, PonsBotFeeVault.ExecutionAuthorization calldata) external {
        require(msg.sender == controller && c == b); controller = c; beneficiary = b;
    }
    function pause() external { require(msg.sender == controller); paused = true; }
    function exit(address recipient) external { require(msg.sender == controller && paused); beneficiary = recipient; active = false; }
}
contract BurnExecutor {
    bool public fail;
    function setFail(bool value) external { fail = value; }
    function buyAndBurn(address, address token, uint256 amount, uint256, bytes calldata) external payable returns (uint256) {
        require(!fail && msg.value == amount); BurnToken(token).mint(0x000000000000000000000000000000000000dEaD, amount * 2);
        return amount * 2;
    }
}
contract BurnHolderRegistry {
    address public destination;
    function set(address value) external { destination = value; }
    function distributorOf(address) external view returns (address) { return destination; }
}
contract BurnPayoutProbe {
    PonsBotCreatorBurnVault public vault;
    bool public reject;
    bool public callbackSucceeded;
    uint256 public received;
    function configure(PonsBotCreatorBurnVault v, bool r) external { vault=v; reject=r; }
    receive() external payable {
        require(!reject);
        received += msg.value;
        (callbackSucceeded,) = address(vault).call(abi.encodeCall(vault.withdrawFor,(address(this))));
    }
}
contract CreatorBurnVaultTest {
    BurnVm constant vm = BurnVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PonsBotCreatorBurnVault vault;
    BurnPrimary primary;
    BurnExecutor executor;
    BurnHolderRegistry registry;
    address constant NEXT = address(123);
    receive() external payable {}
    function setUp() public {
        vm.deal(address(this), 10 ether);
        BurnControl control = new BurnControl(address(this), vm.addr(42));
        primary = new BurnPrimary(address(new BurnToken()), address(control));
        executor = new BurnExecutor(); registry = new BurnHolderRegistry();
        vault = new PonsBotCreatorBurnVault(address(primary), address(this), address(executor), address(registry));
        primary.enroll(address(vault));
    }
    function fund() private { primary.credit{value: 0.95 ether}(); vault.collect(); }
    function signature(uint256 amount, uint256 minimum) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(42, vault.burnDigest(address(this), amount, minimum, block.timestamp, block.timestamp + 100, keccak256("")));
        return abi.encodePacked(r, s, v);
    }
    function testSplitOnlyAfterFivePercent() public {
        vault.setPercentage(2000); fund();
        require(vault.burnReserve(address(this)) == 0.19 ether);
        require(vault.payableTo(address(this)) == 0.76 ether);
    }
    function testDefaultPaysEverything() public { fund(); require(vault.payableTo(address(this)) == 0.95 ether); }
    function testPayoutCallbackCannotDoubleWithdraw() public {
        BurnPayoutProbe probe=new BurnPayoutProbe();probe.configure(vault,false);
        vault.reassign(address(probe));fund();vault.withdrawFor(address(probe));
        require(probe.received()==0.95 ether&&!probe.callbackSucceeded());
        require(vault.payableTo(address(probe))==0&&vault.accounted()==0);
    }
    function testRejectedPayoutPreservesAllocationForRetry() public {
        BurnPayoutProbe probe=new BurnPayoutProbe();probe.configure(vault,true);
        vault.reassign(address(probe));fund();
        (bool ok,)=address(vault).call(abi.encodeCall(vault.withdrawFor,(address(probe))));
        require(!ok&&vault.payableTo(address(probe))==0.95 ether&&vault.accounted()==0.95 ether);
        probe.configure(vault,false);vault.withdrawFor(address(probe));require(probe.received()==0.95 ether);
    }
    function testNativeDonationNeverEntersBurnReserve() public {
        vault.setPercentage(10000);(bool ok,)=address(vault).call{value:1 ether}("");require(ok);
        fund();require(vault.payableTo(address(this))==1 ether&&vault.burnReserve(address(this))==0.95 ether);
    }
    function testActuallyExpiredAuthorizationCannotSpendReserve() public {
        vault.setPercentage(5000);fund();uint256 issued=block.timestamp;
        bytes memory sig=signature(0.475 ether,1);vm.warp(issued+101);
        (bool ok,)=address(vault).call(abi.encodeCall(vault.executeBurn,(address(this),0.475 ether,1,issued,issued+100,bytes(""),sig)));
        require(!ok&&vault.burnReserve(address(this))==0.475 ether);
    }
    function testOldAllocationStaysWithOldOwner() public {
        vault.setPercentage(2000); primary.credit{value: 0.95 ether}(); vault.reassign(NEXT);
        require(vault.payableTo(address(this)) == 0.76 ether && vault.selfBurnBps() == 0);
        primary.credit{value: 0.95 ether}(); vault.collect(); require(vault.payableTo(NEXT) == 0.95 ether);
    }
    function testOutsiderCannotChangePercentage() public {
        vm.prank(NEXT); vm.expectRevert(PonsBotCreatorBurnVault.Unauthorized.selector); vault.setPercentage(1000);
    }
    function testPreviousOwnerLosesControl() public {
        vault.reassign(NEXT); vm.expectRevert(PonsBotCreatorBurnVault.Unauthorized.selector); vault.reassign(address(this));
    }
    function testMaximumPercentage() public { vm.expectRevert(PonsBotCreatorBurnVault.InvalidConfiguration.selector); vault.setPercentage(10001); }
    function testFullReserveCanBeReleasedByItsOwner() public {
        vault.setPercentage(10000); fund(); vault.reassign(NEXT); vault.releaseReserve(0.95 ether);
        require(vault.payableTo(address(this)) == 0.95 ether);
    }
    function testVerifiedBurn() public {
        vault.setPercentage(2000); fund(); bytes memory sig = signature(0.19 ether, 1);
        vault.executeBurn(address(this), 0.19 ether, 1, block.timestamp, block.timestamp + 100, "", sig);
        require(vault.lifetimeSelfBurned() == 0.38 ether && vault.accounted() == 0.76 ether);
    }
    function testRevertedBuyPreservesCashAndReserve() public {
        vault.setPercentage(2000); fund(); executor.setFail(true); bytes memory sig = signature(0.19 ether, 1);
        (bool ok,) = address(vault).call(abi.encodeCall(vault.executeBurn, (address(this), 0.19 ether, 1, block.timestamp, block.timestamp + 100, bytes(""), sig)));
        require(!ok && vault.burnReserve(address(this)) == 0.19 ether);
        vault.withdrawFor(address(this)); require(vault.accounted() == 0.19 ether);
    }
    function testPercentageInvalidatesQuote() public {
        vault.setPercentage(2000); fund(); bytes memory sig = signature(0.19 ether, 1); vault.setPercentage(3000);
        vm.expectRevert(PonsBotCreatorBurnVault.Unauthorized.selector);
        vault.executeBurn(address(this), 0.19 ether, 1, block.timestamp, block.timestamp + 100, "", sig);
    }
    function testHolderExitPreservesCash() public {
        fund(); registry.set(address(executor)); vault.shareWithHolders();
        require(primary.beneficiary() == address(executor) && vault.exited()); vault.withdrawFor(address(this));
    }
    function testEmergencyExitReturnsFeeRights() public { vault.emergencyExitToOwner(); require(primary.beneficiary() == address(this)); }
}
