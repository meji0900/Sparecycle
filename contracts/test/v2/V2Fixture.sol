// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardsFixture} from "../Base.t.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {MockSpare, MockSwapAdapter} from "../mocks/V2Mocks.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

/// @notice Deploys the V2 system next to the ETH-mode reward contract of RewardsFixture:
///         Burner (price source = predicted V2) -> V2 (holder pool = predicted) -> HolderPool.
///         Prices and amounts here are test values only, not market data.
abstract contract V2Fixture is RewardsFixture {
    /// @dev Test price: 0.0001 ETH per SPARE (wei per 1e18 SPARE base units). Not a market price.
    uint256 internal constant PRICE = 1e14;
    uint256 internal constant CAP = 100 ether;
    uint256 internal constant MAX_BURN = 1 ether;
    uint256 internal constant BPS = 10_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockSpare internal spareTok;
    MockSwapAdapter internal adapter;
    SparecycleBurner internal burner;
    SparecycleJobPaymentsV2 internal pay;
    SparecycleHolderPool internal pool;

    function setUp() public virtual override {
        super.setUp();
        spareTok = new MockSpare();
        adapter = new MockSwapAdapter(IERC20(address(spareTok)), PRICE);
        vm.deal(address(adapter), 10_000 ether);
        (burner, pay, pool) = _deploySystem(address(spareTok), address(adapter), true);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _deploySystem(address token, address adapter_, bool useBurn)
        internal
        returns (SparecycleBurner b, SparecycleJobPaymentsV2 p, SparecycleHolderPool hp)
    {
        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        b = new SparecycleBurner(address(ethR), treasury, token, adapter_, v2At, useBurn, MAX_BURN);
        p = new SparecycleJobPaymentsV2(address(ethR), treasury, address(b), poolAt, token, adapter_, CAP);
        hp = new SparecycleHolderPool(address(ethR), address(p), treasury);
        require(address(p) == v2At && address(hp) == poolAt, "prediction");
    }

    // ---------------------------------------------------------------- generic helpers

    function _open() internal view returns (uint64) {
        return ethR.currentEpoch();
    }

    function _one(address c, uint256 a) internal pure returns (address[] memory cs, uint256[] memory as_) {
        cs = new address[](1);
        as_ = new uint256[](1);
        cs[0] = c;
        as_[0] = a;
    }

    function _none() internal pure returns (address[] memory cs, uint256[] memory as_) {
        cs = new address[](0);
        as_ = new uint256[](0);
    }

    function _deposit(address c, uint256 a) internal {
        vm.prank(c);
        pay.deposit{value: a}();
    }

    function _charge(address c, uint256 a) internal {
        (address[] memory cs, uint256[] memory as_) = _one(c, a);
        uint64 id = _open();
        vm.prank(sched);
        pay.charge(id, cs, as_, keccak256("list"));
    }

    // ---------------------------------------------------------------- SPARE helpers

    function _spareDeposit(address c, uint256 amount) internal {
        spareTok.mint(c, amount);
        vm.startPrank(c);
        spareTok.approve(address(pay), amount);
        pay.depositSpare(amount);
        vm.stopPrank();
    }

    /// @dev Safe anchors the reference, then the scheduler posts `price` for the open epoch.
    function _anchorAndPost(uint256 price) internal {
        vm.prank(treasury);
        pay.setReferenceSparePrice(price);
        _post(price);
    }

    function _post(uint256 price) internal {
        uint64 id = _open();
        vm.prank(sched);
        pay.postSparePrice(id, price);
    }

    /// @dev The lowest minEthOut the contract accepts for a SPARE leg worth `ethValue`.
    function _floor(uint256 ethValue) internal view returns (uint256 floor) {
        (,, floor,,) = pay.previewSpareLeg(_open(), 0, ethValue, type(uint128).max);
    }

    /// @dev ETH leg (optional) + one SPARE-paid customer, with `minEthOut` = the floor.
    function _chargeSpare(address ethC, uint256 ethA, address spareC, uint256 spareEth) internal {
        _chargeSpareMin(ethC, ethA, spareC, spareEth, _floor(spareEth));
    }

    function _chargeSpareMin(address ethC, uint256 ethA, address spareC, uint256 spareEth, uint256 minOut) internal {
        (address[] memory cs, uint256[] memory as_) = ethA == 0 ? _none() : _one(ethC, ethA);
        (address[] memory ss, uint256[] memory sa) = _one(spareC, spareEth);
        uint64 id = _open();
        vm.prank(sched);
        pay.chargeWithSpare(id, cs, as_, ss, sa, minOut, keccak256("spare-list"));
    }

    // ---------------------------------------------------------------- holder-pool helpers

    function _holderLeaves(uint64 epochId, address[] memory hs, uint8[] memory modes, uint256[] memory amts)
        internal
        view
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](hs.length);
        for (uint256 i; i < hs.length; ++i) {
            leaves[i] = pool.leafOf(epochId, hs[i], modes[i], amts[i]);
        }
    }

    /// @dev Closes the open epoch (empty node root) and posts a holder root for it over (hs, modes, amts).
    function _closeAndPostHolders(address[] memory hs, uint8[] memory modes, uint256[] memory amts)
        internal
        returns (uint64 epochId, bytes32[] memory leaves)
    {
        epochId = _closeEmpty(ethR);
        leaves = _holderLeaves(epochId, hs, modes, amts);
        uint256 total;
        for (uint256 i; i < amts.length; ++i) {
            total += amts[i];
        }
        vm.prank(sched);
        pool.postRoot(epochId, MerkleHelper.root(leaves), total);
    }

    function _holderClaim(uint64 epochId, bytes32[] memory leaves, address h, uint8 mode, uint256 amount) internal {
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(epochId, h, mode, amount));
        vm.prank(h);
        pool.claim(epochId, mode, amount, p);
    }

    function _arr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _arr(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _u(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _u(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _m(uint8 a) internal pure returns (uint8[] memory r) {
        r = new uint8[](1);
        r[0] = a;
    }

    function _m(uint8 a, uint8 b) internal pure returns (uint8[] memory r) {
        r = new uint8[](2);
        r[0] = a;
        r[1] = b;
    }

    /// @dev V2's ETH balance covers exactly the three internal buckets (no forced ETH in these tests).
    function _assertV2Accounting() internal view {
        assertEq(address(pay).balance, pay.totalBalance() + pay.totalCredits() + pay.discountReserve(), "v2 eth");
        assertEq(spareTok.balanceOf(address(pay)), pay.totalSpareBalance(), "v2 spare");
    }
}
