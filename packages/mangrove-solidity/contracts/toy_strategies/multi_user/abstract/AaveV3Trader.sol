// SPDX-License-Identifier:	BSD-2-Clause

// AaveV3Trader.sol

// Copyright (c) 2021 Giry SAS. All rights reserved.

// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

// 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

pragma solidity ^0.8.10;
pragma abicoder v2;
import "./AaveV3Lender.sol";

abstract contract MultiUserAaveV3Trader is AaveV3Module, MultiUser {
  function __get__(uint amount, ML.SingleOrder calldata order)
    internal
    virtual
    override
    returns (uint)
  {
    address owner = ownerOf(
      IERC20(order.outbound_tkn),
      IERC20(order.inbound_tkn),
      order.offerId
    );
    // 1. Computing total borrow and redeem capacities of underlying asset
    (uint redeemable, uint liquidity_after_redeem) = maxGettableUnderlying(
      IERC20(order.outbound_tkn),
      true,
      owner
    );
    // Fail early to prevent AAVE manipulation by flashloans
    if (redeemable + liquidity_after_redeem < amount) {
      return amount;
    }
    // 2. trying to redeem liquidity from AAVE
    uint toRedeem = redeemable < amount ? redeemable : amount;
    if (toRedeem == 0) {
      return amount;
    }
    IERC20 aToken = overlying(IERC20(order.outbound_tkn));
    try aToken.transferFrom(owner, address(this), amount) returns (
      bool success
    ) {
      if (success) {
        // overlying transfer has succeeded, anything wrong beyond this point should revert
        require(
          POOL.withdraw(order.outbound_tkn, toRedeem, address(this)) == amount,
          "mgvOffer/aave/redeemFailed"
        );
        amount = amount - toRedeem;
        if (amount == 0) {
          return 0;
        }
        uint toBorrow = (liquidity_after_redeem < amount)
          ? liquidity_after_redeem
          : amount;
        // 3. trying to borrow missing liquidity, failure to borrow reverts
        POOL.borrow(
          order.outbound_tkn,
          toBorrow,
          INTEREST_RATE_MODE,
          REFERRAL_CODE,
          address(this)
        );
        return 0;
      }
    } catch {}
    // overlying transfer reverted or `success == false`.
    return amount;
  }

  function __put__(uint amount, ML.SingleOrder calldata order)
    internal
    virtual
    override
    returns (uint)
  {
    //optim
    if (amount == 0) {
      return 0;
    }
    // trying to repay debt if user is in borrow position for inbound_tkn token
    DataTypes.ReserveData memory reserveData = POOL.getReserveData(
      order.inbound_tkn
    );

    uint debtOfUnderlying;
    if (INTEREST_RATE_MODE == 1) {
      debtOfUnderlying = IERC20(reserveData.stableDebtTokenAddress).balanceOf(
        address(this)
      );
    } else {
      debtOfUnderlying = IERC20(reserveData.variableDebtTokenAddress).balanceOf(
          address(this)
        );
    }

    uint toRepay = (debtOfUnderlying < amount) ? debtOfUnderlying : amount;

    uint toMint;
    address owner = ownerOf(
      IERC20(order.outbound_tkn),
      IERC20(order.inbound_tkn),
      order.offerId
    );
    try POOL.repay(order.inbound_tkn, toRepay, INTEREST_RATE_MODE, owner) {
      toMint = amount - toRepay;
    } catch {
      toMint = amount;
    }
    _supply(IERC20(order.inbound_tkn), toMint, owner);
    return 0;
  }
}