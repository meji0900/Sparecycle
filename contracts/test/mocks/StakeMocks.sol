// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleNodeStake} from "../../src/SparecycleNodeStake.sol";

/// @notice Stands in for SPARE when it has `burn(uint256)` (ERC20Burnable, 18 decimals).
contract MockBurnableERC20 is ERC20Burnable {
    constructor() ERC20("SpareCycle", "SPARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Has a `burn(uint256)` that does nothing: the contract must notice its balance did not drop.
contract NoopBurnToken is ERC20 {
    constructor() ERC20("Noop burn", "NOOP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256) external {}
}

/// @notice Takes an extra 1% from the *sender's* remaining balance on every transfer out of `taxed`, so the sender
///         loses more than it sent. The stake contract must refuse such an outflow (it would spend other stakes).
contract SenderTaxToken is ERC20 {
    address public taxed;
    address public constant SINK = address(0xBEEF);

    constructor() ERC20("Sender tax", "STAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTaxed(address a) external {
        taxed = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && from == taxed && to != SINK) {
            uint256 extra = value / 100;
            if (extra != 0 && balanceOf(from) >= extra) super._update(from, SINK, extra);
        }
    }
}

interface ITokenHook {
    function onTokenSent(address to, uint256 amount) external;
    function onTokenReceived(address from, uint256 amount) external;
}

/// @notice ERC-20 with ERC-777-style callbacks to opted-in addresses after every balance change, so a holder can try
///         to re-enter the stake contract in the middle of `stake` (sender hook) or `unstake` (receiver hook).
contract HookToken is ERC20 {
    mapping(address => bool) public hooked;

    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHooked(address a, bool on) external {
        hooked[a] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && hooked[from]) ITokenHook(from).onTokenSent(to, value);
        if (to != address(0) && hooked[to]) ITokenHook(to).onTokenReceived(from, value);
    }
}

/// @notice Owner wallet that re-enters the stake contract from token callbacks and records the error it got.
contract ReentrantStaker is ITokenHook {
    enum Mode {
        None,
        StakeOnSend, // during stake(): stake again (would double count the balance delta)
        UnstakeOnReceive, // during unstake(): unstake again (would pay twice)
        RequestOnReceive, // during unstake(): request another unstake (cross-function)
        StakeOnReceive // during unstake(): stake the received tokens back (cross-function)
    }

    SparecycleNodeStake public immutable st;
    IERC20 public immutable tok;
    Mode public mode;
    bool public tried;
    bytes public err;

    constructor(SparecycleNodeStake st_, IERC20 tok_) {
        st = st_;
        tok = tok_;
        tok_.approve(address(st_), type(uint256).max);
    }

    function setMode(Mode m) external {
        mode = m;
        tried = false;
        delete err;
    }

    function doStake(uint256 amount) external {
        st.stake(amount);
    }

    function doRequest(uint256 amount) external {
        st.requestUnstake(amount);
    }

    function doUnstake() external {
        st.unstake();
    }

    function onTokenSent(address, uint256) external {
        if (msg.sender != address(tok) || tried || mode != Mode.StakeOnSend) return;
        tried = true;
        try st.stake(1) {}
        catch (bytes memory e) {
            err = e;
        }
    }

    function onTokenReceived(address, uint256) external {
        if (msg.sender != address(tok) || tried) return;
        if (mode == Mode.UnstakeOnReceive) {
            tried = true;
            try st.unstake() {}
            catch (bytes memory e) {
                err = e;
            }
        } else if (mode == Mode.RequestOnReceive) {
            tried = true;
            try st.requestUnstake(1) {}
            catch (bytes memory e) {
                err = e;
            }
        } else if (mode == Mode.StakeOnReceive) {
            tried = true;
            try st.stake(1) {}
            catch (bytes memory e) {
                err = e;
            }
        }
    }
}
