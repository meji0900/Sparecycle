// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManagerMinimal, IUnlockCallback, PoolKey, SwapParams} from "../../src/interfaces/IUniswapV4Minimal.sol";

/// @notice A small stand-in for the Uniswap v4 PoolManager with its flash accounting: `unlock` calls back the caller,
///         `swap` / `settle` / `take` move per-currency deltas, and `unlock` reverts unless every delta is back to
///         zero (v4's CurrencyNotSettled). One pool, a fixed rate (SPARE base units per wei of ETH) and an optional
///         fee on the output, like the Pons hook's afterSwap cut. Test values only, not market data.
contract MockPoolManager is IPoolManagerMinimal {
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    mapping(bytes32 => bytes32) internal _words;
    /// @notice SPARE base units per wei of ETH (e.g. 25_000_000).
    uint256 public rate;
    /// @notice Output fee in bps (290 = the Pons hook's 100 + 190 on the SPARE pool).
    uint256 public outFeeBps;
    /// @notice Consume this much less input than specified (a partial fill).
    uint256 public shortFill;
    /// @notice Return a zero output.
    bool public zeroOut;

    bool public unlocked;
    address public locker;
    address public syncedCurrency;
    uint256 public syncedReserves;
    mapping(address => int256) public deltaOf;
    address[] internal _touched;

    uint256 public swaps;
    PoolKey public lastKey;
    SwapParams public lastParams;

    error AlreadyUnlocked();
    error ManagerLocked();
    error CurrencyNotSettled();
    error NonzeroNativeValue();
    error WrongPool();

    receive() external payable {}

    function setPool(PoolKey memory key, uint160 sqrtPriceX96) external {
        bytes32 id = keccak256(abi.encode(key));
        _words[keccak256(abi.encodePacked(id, POOLS_SLOT))] = bytes32(uint256(sqrtPriceX96));
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setOutFeeBps(uint256 bps) external {
        outFeeBps = bps;
    }

    function setShortFill(uint256 v) external {
        shortFill = v;
    }

    function setZeroOut(bool v) external {
        zeroOut = v;
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _words[slot];
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (unlocked) revert AlreadyUnlocked();
        unlocked = true;
        locker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; ++i) {
            if (deltaOf[_touched[i]] != 0) revert CurrencyNotSettled();
        }
        delete _touched;
        unlocked = false;
        locker = address(0);
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (int256) {
        if (!unlocked) revert ManagerLocked();
        if (_words[keccak256(abi.encodePacked(keccak256(abi.encode(key)), POOLS_SLOT))] == 0) revert WrongPool();
        require(params.amountSpecified < 0, "mock: exact input only");
        swaps += 1;
        lastKey = key;
        lastParams = params;
        uint256 amountIn = uint256(-params.amountSpecified) - shortFill;
        uint256 out = params.zeroForOne ? amountIn * rate : amountIn / rate;
        out -= (out * outFeeBps) / 10_000;
        if (zeroOut) out = 0;
        int128 a0 = params.zeroForOne ? -int128(int256(amountIn)) : int128(int256(out));
        int128 a1 = params.zeroForOne ? int128(int256(out)) : -int128(int256(amountIn));
        _account(key.currency0, a0);
        _account(key.currency1, a1);
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        syncedCurrency = currency;
        syncedReserves = currency == address(0) ? 0 : IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (!unlocked) revert ManagerLocked();
        address c = syncedCurrency;
        if (c == address(0)) {
            paid = msg.value;
        } else {
            if (msg.value != 0) revert NonzeroNativeValue();
            paid = IERC20(c).balanceOf(address(this)) - syncedReserves;
            syncedCurrency = address(0);
        }
        _account(c, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external {
        if (!unlocked) revert ManagerLocked();
        _account(currency, -int256(amount));
        if (currency == address(0)) {
            (bool ok, bytes memory err) = to.call{value: amount}("");
            if (!ok) {
                assembly {
                    revert(add(err, 32), mload(err))
                }
            }
        } else {
            require(IERC20(currency).transfer(to, amount), "mock: take");
        }
    }

    function _account(address currency, int256 d) internal {
        if (d == 0) return;
        if (deltaOf[currency] == 0) _touched.push(currency);
        deltaOf[currency] += d;
    }
}
