// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev Local stand-in for testnet AUSD: 6 decimals, symbol "AUSD", EIP-712 domain name "Agora Dollar" v1
///      (matches the live token's eip712Domain() on chain 10143).
contract MockAUSD is ERC20, ERC20Permit {
    constructor() ERC20("AUSD", "AUSD") ERC20Permit("Agora Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract Mock18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}
