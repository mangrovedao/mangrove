// SPDX-License-Identifier:	BSD-2-Clause

// PriceFed.sol

// Copyright (c) 2021 Giry SAS. All rights reserved.

// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

// 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
pragma solidity ^0.8.10;
pragma abicoder v2;

import "../../Defensive.sol";
import "../../AaveV2Lender.sol";

contract PriceFed is Defensive, AaveV2Lender {
  constructor(
    address _oracle,
    address _addressesProvider,
    address payable _MGV
  ) Defensive(_oracle) AaveV2Module(_addressesProvider, 0) MangroveOffer(_MGV) {
    setGasreq(800_000);
  }

  using P.Offer for P.Offer.t;
  using P.OfferDetail for P.OfferDetail.t;
  using P.Global for P.Global.t;
  using P.Local for P.Local.t;

  event Slippage(uint indexed offerId, uint old_wants, uint new_wants);

  // reposts only if offer was reneged due to a price slippage
  function __posthookReneged__(ML.SingleOrder calldata order)
    internal
    override
  {
    uint old_wants = order.offer.wants();
    uint old_gives = order.offer.gives();
    uint price_quote = oracle.getPrice(order.inbound_tkn);
    uint price_base = oracle.getPrice(order.outbound_tkn);

    uint new_offer_wants = div_(mul_(old_gives, price_base), price_quote);
    emit Slippage(order.offerId, old_wants, new_offer_wants);
    // since offer is persistent it will auto refill if contract does not have enough provision on the Mangrove
    try
      MGV.updateOffer(
        order.outbound_tkn,
        order.inbound_tkn,
        new_offer_wants,
        old_gives,
        OFR_GASREQ,
        0,
        0,
        order.offerId
      )
    {} catch Error(string memory message) {
      emit PosthookFail(
        order.outbound_tkn,
        order.inbound_tkn,
        order.offerId,
        message
      );
    }
  }

  // Closing diamond inheritance for solidity compiler
  // get/put and lender strat's functions
  function __get__(uint amount, ML.SingleOrder calldata order)
    internal
    override(SingleUser, AaveV2Lender)
    returns (uint)
  {
    return AaveV2Lender.__get__(amount, order);
  }

  function __put__(uint amount, ML.SingleOrder calldata order)
    internal
    override(SingleUser, AaveV2Lender)
    returns (uint)
  {
    return AaveV2Lender.__put__(amount, order);
  }

  // lastlook is defensive strat's function
  function __lastLook__(ML.SingleOrder calldata order)
    internal
    virtual
    override(MangroveOffer, Defensive)
    returns (bool)
  {
    return Defensive.__lastLook__(order);
  }
}
