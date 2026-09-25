// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPonsFeeEscrow} from "../../src/interfaces/IPonsFeeEscrow.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";

/// @notice Plain mintable ERC-20 (stands in for USDG, 6 decimals like it).
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-20 that burns 1% of every transfer (unsupported as payout token; used to prove delta crediting).
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice ERC-20 with a second ("legacy") entry point that moves the same balances (TUSD-style).
contract DoubleEntryToken is ERC20 {
    address public legacy;

    constructor() ERC20("Double", "DBL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setLegacy(address l) external {
        legacy = l;
    }

    function delegateTransfer(address from, address to, uint256 amount) external returns (bool) {
        require(msg.sender == legacy, "only legacy");
        _transfer(from, to, amount);
        return true;
    }
}

/// @notice Legacy entry point of `DoubleEntryToken`: `transfer` moves the underlying token's balance.
contract DoubleEntryLegacy {
    DoubleEntryToken public immutable underlying;

    constructor(DoubleEntryToken u) {
        underlying = u;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return underlying.delegateTransfer(msg.sender, to, amount);
    }

    function balanceOf(address a) external view returns (uint256) {
        return underlying.balanceOf(a);
    }
}

/// @notice Pushes ETH with the 2300-gas stipend, the way a contract using `transfer`/`send` would.
contract EthPusher {
    function pushTransfer(address payable to) external payable {
        to.transfer(msg.value);
    }

    function pushSend(address payable to) external payable returns (bool ok) {
        ok = to.send(msg.value);
        require(ok, "send failed");
    }
}

/// @notice Contract that rejects ETH.
contract EthRejecter {
    function doClaim(SparecycleRewards r, uint64 epochId, uint256 amount, bytes32[] calldata proof) external {
        r.claim(epochId, amount, proof);
    }

    receive() external payable {
        revert("no ETH");
    }
}

/// @notice Tries to re-enter `claim` (and `sync`) from its `receive()`; records what happened.
contract ReentrantClaimer {
    SparecycleRewards public immutable rewards;
    uint64 public epochId;
    uint256 public amount;
    bytes32[] public proof;
    bool public reentered;
    bytes public reentryError;
    uint256 public received;

    constructor(SparecycleRewards r) {
        rewards = r;
    }

    function doClaim(uint64 e, uint256 a, bytes32[] calldata p) external {
        epochId = e;
        amount = a;
        proof = p;
        rewards.claim(e, a, p);
    }

    receive() external payable {
        received += msg.value;
        if (reentered) return;
        reentered = true;
        try rewards.claim(epochId, amount, proof) {}
        catch (bytes memory err) {
            reentryError = err;
        }
    }
}

/// @notice Malicious escrow: during `claim()` it pays and also calls `fund()` with the same value, trying to
///         get the inflow counted twice (once as `fund`, once in the balance delta).
contract DoubleCountEscrow is IPonsFeeEscrow {
    uint256 public bal;

    function credit(address) external payable {
        bal += msg.value;
    }

    function claim() external {
        uint256 a = bal;
        bal = 0;
        SparecycleRewards(payable(msg.sender)).fund{value: a}();
    }

    function claimToken(address) external pure {
        revert("unused");
    }

    function balanceOf(address) external view returns (uint256) {
        return bal;
    }

    function balanceOfToken(address, address) external pure returns (uint256) {
        return 0;
    }
}
