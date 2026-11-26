// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISpareSwapAdapter} from "../../src/interfaces/ISparecycleV2.sol";

/// @notice SPARE stand-in: 18 decimals, public mint, and `burn(uint256)` like the selector seen in SPARE's bytecode.
contract MockSpare is ERC20 {
    constructor() ERC20("SpareCycle", "SPARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/// @notice A token whose `burn` only moves the tokens to a vault: the total supply does not drop.
contract FakeBurnSpare is ERC20 {
    constructor() ERC20("FakeBurn", "FBURN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _transfer(msg.sender, address(0xBEEF), amount);
    }
}

/// @notice Fee-on-transfer SPARE stand-in (1% of every transfer is burned). No burn function.
contract FeeOnTransferSpare is ERC20 {
    constructor() ERC20("FeeSpare", "FSPARE") {}

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

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Swap adapter mock with a settable execution price (wei per 1e18 SPARE base units) and switches for
///         misbehaviour. Buys mint SPARE; sells pay ETH from the adapter's own balance.
contract MockSwapAdapter is ISpareSwapAdapter {
    IERC20 public immutable token;
    /// @notice Execution price: wei of ETH per 1e18 SPARE base units.
    uint256 public price;

    // misbehaviour switches
    bool public ignoreMinOut; // deliver the computed amount even when below the minimum
    uint256 public shortBps; // deliver this many bps less than computed (a bad fill)
    uint256 public pullLessBy; // sellSpare pulls this much less SPARE than asked
    uint256 public refundWei; // buySpare refunds this much ETH to the caller
    bool public payFromBalance; // buySpare transfers SPARE from the adapter's balance instead of minting
    address public hookTarget; // called during the swap (reentrancy tests)
    bytes public hookData;
    uint256 public hookValue;
    bool public hookOk;
    bytes public hookErr;
    uint256 public hookCalls;

    constructor(IERC20 token_, uint256 price_) {
        token = token_;
        price = price_;
    }

    receive() external payable {}

    function setPrice(uint256 p) external {
        price = p;
    }

    function setIgnoreMinOut(bool v) external {
        ignoreMinOut = v;
    }

    function setShortBps(uint256 v) external {
        shortBps = v;
    }

    function setPullLessBy(uint256 v) external {
        pullLessBy = v;
    }

    function setPayFromBalance(bool v) external {
        payFromBalance = v;
    }

    function setRefundWei(uint256 v) external {
        refundWei = v;
    }

    function setHook(address target, bytes calldata data, uint256 value) external {
        hookTarget = target;
        hookData = data;
        hookValue = value;
    }

    function quoteBuy(uint256 ethIn) public view returns (uint256) {
        return (ethIn * 1e18) / price * (10_000 - shortBps) / 10_000;
    }

    function quoteSell(uint256 spareIn) public view returns (uint256) {
        return (spareIn * price) / 1e18 * (10_000 - shortBps) / 10_000;
    }

    function buySpare(uint256 minSpareOut, address to) external payable returns (uint256 out) {
        _hook();
        out = quoteBuy(msg.value - refundWei);
        if (!ignoreMinOut) require(out >= minSpareOut, "adapter: min out");
        if (payFromBalance) require(token.transfer(to, out), "pay spare");
        else IMintable(address(token)).mint(to, out);
        if (refundWei != 0) {
            (bool ok,) = msg.sender.call{value: refundWei}("");
            require(ok, "refund");
        }
    }

    function sellSpare(uint256 spareIn, uint256 minEthOut, address payable to) external returns (uint256 out) {
        uint256 pull = spareIn - pullLessBy;
        require(token.transferFrom(msg.sender, address(this), pull), "pull");
        _hook();
        out = quoteSell(pull);
        if (!ignoreMinOut) require(out >= minEthOut, "adapter: min out");
        (bool ok,) = to.call{value: out}("");
        require(ok, "pay");
    }

    function _hook() internal {
        if (hookTarget == address(0)) return;
        hookCalls += 1;
        (bool ok, bytes memory err) = hookTarget.call{value: hookValue}(hookData);
        hookOk = ok;
        hookErr = err;
    }
}

/// @notice Sends ETH to a target from a separate contract (to test unexpected ETH during a swap).
contract EthSender {
    receive() external payable {}

    function send(address to, uint256 amount) external {
        (bool ok, bytes memory err) = to.call{value: amount}("");
        if (!ok) {
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
    }
}
