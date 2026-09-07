// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PonsBotFeeVault.sol";

interface ICreatorBurnExecutor {
    function buyAndBurn(address asset, address token, uint256 amount, uint256 minimumOut, bytes calldata route)
        external payable returns (uint256 burned);
}
interface ICreatorHolderRegistry {
    function distributorOf(address token) external view returns (address);
}

/// @notice Opt-in second layer. Receives ONLY the upstream beneficiary allocation.
/// @dev Replacement layer version 2. The existing primary vault is unchanged.
contract PonsBotCreatorBurnVault {
    PonsBotFeeVault public immutable upstream;
    address public immutable token;
    address public immutable asset;
    address public immutable feeControl;
    address public immutable executor;
    bytes32 public immutable executorCodeHash;
    address public immutable holderRegistry;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_QUOTE_LIFETIME = 10 minutes;
    address public owner;
    uint16 public selfBurnBps;
    uint256 public configurationNonce;
    uint256 public executionNonce;
    uint256 public accounted;
    uint256 public lifetimeSelfBurned;
    uint256 public lifetimeSelfSpend;
    bool public exited;
    bool public everActivated;
    bool private entered;
    mapping(address => uint256) public payableTo;
    mapping(address => uint256) public burnReserve;

    event Allocation(address indexed owner, uint256 received, uint256 cash, uint256 reserve);
    event SurplusReceived(address indexed owner, uint256 amount);
    event ConfigurationChanged(address indexed owner, uint16 bps, uint256 nonce);
    event OwnershipChanged(address indexed previousOwner, address indexed nextOwner);
    event Paid(address indexed owner, uint256 amount);
    event ReserveReleased(address indexed owner, uint256 amount);
    event SelfBurned(address indexed owner, uint256 spent, uint256 burned);
    event Exited(address indexed recipient);
    error Unauthorized();
    error InvalidConfiguration();
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier guarded() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }

    constructor(address primary, address owner_, address executor_, address holderRegistry_) {
        if (primary.code.length == 0 || executor_.code.length == 0 || holderRegistry_.code.length == 0
            || owner_ == address(0) || owner_ == address(this)) revert InvalidConfiguration();
        upstream = PonsBotFeeVault(payable(primary));
        if (!upstream.active() || upstream.controller() != owner_ || upstream.beneficiary() != owner_)
            revert Unauthorized();
        token = upstream.token(); asset = upstream.pairAsset(); feeControl = upstream.feeControl();
        if (token == asset) revert InvalidConfiguration();
        owner = owner_; executor = executor_; executorCodeHash = executor_.codehash; holderRegistry = holderRegistry_;
    }

    // No swap, accounting callback, or external call during upstream ETH delivery.
    receive() external payable {}

    function active() public view returns (bool) {
        return !exited && upstream.active() && upstream.controller() == address(this)
            && upstream.beneficiary() == address(this);
    }

    function _balance() private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20FeeVault(asset).balanceOf(address(this));
    }

    /// @notice Permissionless synchronization of an UNUSED layer to live rights.
    /// The enrollment signer must also match owner to the signing wallet immediately
    /// before transferring primary control. Creating a layer is not consent to enroll.
    function syncDormantOwner() external guarded {
        if (everActivated || exited || !upstream.active() || upstream.controller() == address(this)
            || upstream.controller() != upstream.beneficiary()) revert InvalidConfiguration();
        _collect();
        address current = upstream.controller();
        if (current == address(0)) revert InvalidConfiguration();
        if (owner != current) {
            address previous = owner;
            owner = current; selfBurnBps = 0; configurationNonce++;
            emit OwnershipChanged(previous, current);
        }
    }

    function _collect() private {
        if (active()) everActivated = true;
        uint256 beforeBalance = _balance();
        if (beforeBalance < accounted) revert InvalidConfiguration();
        // Only our own upstream pull is classified as fee income. Direct transfers
        // are separately recoverable cash, never inferred fees or automatic burns.
        uint256 surplus = beforeBalance - accounted;
        if (surplus != 0) {
            payableTo[owner] += surplus; accounted = beforeBalance;
            emit SurplusReceived(owner, surplus);
        }
        uint256 available = upstream.claimable(address(this), asset);
        if (available != 0) upstream.withdraw(asset, address(this), available);
        uint256 balance = _balance();
        uint256 received = balance - beforeBalance;
        if (received > available) revert InvalidConfiguration();
        if (received == 0) return;
        uint256 reserve = received * selfBurnBps / 10_000;
        burnReserve[owner] += reserve;
        payableTo[owner] += received - reserve;
        accounted = balance;
        emit Allocation(owner, received, received - reserve, reserve);
    }

    function collect() external guarded {
        if (!active() && !exited) revert InvalidConfiguration();
        _collect();
    }

    /// @notice Pull the upstream allocation and deliver the current owner's cash
    /// in one transaction. A self-buyback is deliberately a separate transaction:
    /// its quote, economic threshold or revert cannot roll back this payout.
    function collectAndPay() external guarded {
        if (!active() && !exited) revert InvalidConfiguration();
        _collect();
        if (payableTo[owner] != 0) _withdrawFor(owner);
    }

    function setPercentage(uint16 bps) external onlyOwner guarded {
        if (!active() || bps > 10_000) revert InvalidConfiguration();
        _collect(); // Existing credited funds use their previous allocation.
        selfBurnBps = bps; configurationNonce++;
        emit ConfigurationChanged(owner, bps, configurationNonce);
    }

    function reassign(address nextOwner) external onlyOwner guarded {
        if (!active() || nextOwner == address(0) || nextOwner == address(this)
            || nextOwner == address(upstream) || nextOwner == owner) revert InvalidConfiguration();
        _collect();
        address previous = owner;
        owner = nextOwner; selfBurnBps = 0; configurationNonce++;
        emit OwnershipChanged(previous, nextOwner);
        emit ConfigurationChanged(nextOwner, 0, configurationNonce);
    }

    function withdrawFor(address beneficiary) external guarded {
        _withdrawFor(beneficiary);
    }

    function _withdrawFor(address beneficiary) private {
        // Permissionless delivery has a fixed destination, never caller-chosen.
        uint256 amount = payableTo[beneficiary];
        if (amount == 0) revert InvalidConfiguration();
        payableTo[beneficiary] = 0; accounted -= amount;
        _transfer(beneficiary, amount);
        emit Paid(beneficiary, amount);
    }

    function releaseReserve(uint256 amount) external guarded {
        if (amount == 0 || amount > burnReserve[msg.sender]) revert InvalidConfiguration();
        burnReserve[msg.sender] -= amount; payableTo[msg.sender] += amount;
        executionNonce++;
        emit ReserveReleased(msg.sender, amount);
    }

    function burnDigest(address beneficiary, uint256 amount, uint256 minimumOut, uint256 issuedAt, uint256 deadline, bytes32 routeHash)
        public view returns (bytes32)
    {
        bytes32 trade = keccak256(abi.encode(token, asset, beneficiary, amount, minimumOut));
        bytes32 validity = keccak256(abi.encode(issuedAt, deadline, executor, routeHash, configurationNonce, executionNonce));
        return keccak256(abi.encode("PonsBotCreatorBurnVault:2", block.chainid, address(this), address(upstream), trade, validity));
    }

    function executeBurn(address beneficiary, uint256 amount, uint256 minimumOut, uint256 issuedAt, uint256 deadline,
        bytes calldata route, bytes calldata signature) external guarded returns (uint256 burned)
    {
        IPonsBotFeeControl control = IPonsBotFeeControl(feeControl);
        if (msg.sender != control.keeper() || !control.processingEnabled()) revert Unauthorized();
        if (!active() || amount == 0 || amount > burnReserve[beneficiary] || minimumOut == 0
            || issuedAt > block.timestamp || deadline < block.timestamp || deadline < issuedAt
            || deadline - issuedAt > MAX_QUOTE_LIFETIME || signature.length != 65) revert InvalidConfiguration();
        _verify(burnDigest(beneficiary, amount, minimumOut, issuedAt, deadline, keccak256(route)), signature);
        executionNonce++; burnReserve[beneficiary] -= amount; accounted -= amount;
        burned = _swap(amount, minimumOut, route);
        lifetimeSelfBurned += burned; lifetimeSelfSpend += amount;
        emit SelfBurned(beneficiary, amount, burned);
    }

    function _swap(uint256 amount, uint256 minimumOut, bytes calldata route) private returns (uint256 burned) {
        if (executor.codehash != executorCodeHash) revert InvalidConfiguration();
        uint256 beforeBalance = _balance();
        uint256 deadBefore = IERC20FeeVault(token).balanceOf(DEAD);
        if (asset != address(0)) { _approve(0); _approve(amount); }
        uint256 reported = ICreatorBurnExecutor(executor).buyAndBurn{value: asset == address(0) ? amount : 0}(
            asset, token, amount, minimumOut, route);
        if (asset != address(0)) _approve(0);
        burned = IERC20FeeVault(token).balanceOf(DEAD) - deadBefore;
        if (beforeBalance - _balance() != amount || burned < minimumOut || reported != burned) revert InvalidConfiguration();
    }

    function _verify(bytes32 digest, bytes calldata signature) private view {
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) revert Unauthorized();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != IPonsBotFeeControl(feeControl).quoteAuthorizer()) revert Unauthorized();
    }

    /// @notice Returns upstream control directly to the current owner.
    function detach(PonsBotFeeVault.ExecutionAuthorization calldata authorization) external onlyOwner guarded {
        if (!active()) revert InvalidConfiguration();
        upstream.settleAndReassign(owner, owner, authorization);
        _collect(); exited = true; configurationNonce++;
        emit Exited(owner);
    }

    function shareWithHolders() external onlyOwner guarded {
        if (!active()) revert InvalidConfiguration();
        address distributor = ICreatorHolderRegistry(holderRegistry).distributorOf(token);
        if (distributor == address(0) || distributor.code.length == 0) revert InvalidConfiguration();
        upstream.pause(); upstream.exit(distributor);
        _collect(); exited = true; configurationNonce++;
        emit Exited(distributor);
    }

    function emergencyExitToOwner() external onlyOwner guarded {
        if (!active()) revert InvalidConfiguration();
        upstream.pause(); upstream.exit(owner);
        _collect(); exited = true; configurationNonce++;
        emit Exited(owner);
    }

    function _transfer(address recipient, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = recipient.call{value: amount}(""); if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory data) = asset.call(abi.encodeCall(IERC20FeeVault.transfer, (recipient, amount)));
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        }
    }
    function _approve(uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeCall(IERC20FeeVault.approve, (executor, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
