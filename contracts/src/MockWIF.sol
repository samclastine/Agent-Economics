// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only mock of $WIF. 18 decimals. NOT the real WIF token.
contract MockWIF is ERC20 {
    constructor(uint256 initialSupply) ERC20("Mock WIF", "tWIF") {
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
