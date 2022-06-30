// SPDX-License-Identifier:	BSD-2-Clause

//ITreasury.sol

// Copyright (c) 2021 Giry SAS. All rights reserved.

// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

// 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

pragma solidity ^0.8.10;
pragma abicoder v2;

import "contracts/Strategies/interfaces/IEIP20.sol";
import "contracts/Strategies/utils/AccessControlled.sol";

import "hardhat/console.sol";

abstract contract AbstractRouter is AccessControlled {
  mapping(address => bool) public makers;
  modifier onlyMakers() {
    require(makers[msg.sender], "Router/unauthorized");
    _;
  }
  modifier makersOrAdmin() {
    require(msg.sender == admin() || makers[msg.sender], "Router/unauthorized");
    _;
  }

  constructor(address deployer) AccessControlled(deployer) {}

  // pulls `amount` of `token`s from reserve to maker contract's balance
  // `reserve` is typically an EOA (for nice UX), the router contract itself (to minimize fragmentation when router is bound to several makers)
  // or the Maker contract (to minimize transfer costs)
  function pull(
    IEIP20 token,
    address reserve,
    uint amount,
    bool strict
  ) external onlyMakers returns (uint pulled) {
    pulled = __pull__({
      token: token,
      reserve: reserve,
      maker: msg.sender,
      amount: amount,
      strict: strict
    });
  }

  function __pull__(
    IEIP20 token,
    address reserve,
    address maker,
    uint amount,
    bool strict
  ) internal virtual returns (uint);

  // pushes `amount` of `token`s from maker contract to reserve
  function push(
    IEIP20 token,
    address reserve,
    uint amount
  ) external onlyMakers {
    __push__({
      token: token,
      reserve: reserve,
      maker: msg.sender,
      amount: amount
    });
  }

  function __push__(
    IEIP20 token,
    address reserve,
    address maker,
    uint amount
  ) internal virtual;

  function flush(IEIP20[] calldata tokens, address reserve)
    external
    onlyMakers
  {
    for (uint i = 0; i < tokens.length; i++) {
      __push__(tokens[i], reserve, msg.sender, tokens[i].balanceOf(msg.sender));
    }
  }

  /// pushes native token according to `reserve` policy
  function push_native(address reserve)
    external
    payable
    onlyMakers
    returns (bool)
  {
    return __push_native__(reserve, msg.value);
  }

  function __push_native__(address reserve, uint amount)
    internal
    virtual
    returns (bool);

  // checks amount of `token`s available in the liquidity source
  function reserveBalance(IEIP20 token, address reserve)
    external
    view
    virtual
    returns (uint);

  function reserveNativeBalance(address reserve)
    public
    view
    virtual
    returns (uint);

  // withdraws `amount` of reserve tokens and sends them to `recipient`
  function withdrawToken(
    IEIP20 token,
    address reserve,
    address recipient,
    uint amount
  ) public makersOrAdmin returns (bool) {
    return __withdrawToken__(token, reserve, recipient, amount);
  }

  function __withdrawToken__(
    IEIP20 token,
    address reserve,
    address to,
    uint amount
  ) internal virtual returns (bool);

  // connect a maker contract to this router
  function bind(address maker) public makersOrAdmin {
    console.log(msg.sender);
    console.log(admin());
    makers[maker] = true;
  }

  function unbind(address maker) public makersOrAdmin {
    makers[maker] = false;
  }
}
