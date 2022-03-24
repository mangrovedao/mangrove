// SPDX-License-Identifier:	BSD-2-Clause

// AdvancedCompoundRetail.sol

// Copyright (c) 2021 Giry SAS. All rights reserved.

// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

// 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
pragma solidity ^0.8.10;
pragma abicoder v2;
import "../AaveV2Lender.sol";
import "../Persistent.sol";

contract OfferProxy is MultiUserAaveV2Lender, MultiUserPersistent {
  constructor(address _addressesProvider, address payable _MGV)
    AaveV2Module(_addressesProvider, 0)
    MangroveOffer(_MGV)
  {
    setGasreq(800_000); // Offer proxy requires AAVE interactions
  }

  function __put__(uint amount, ML.SingleOrder calldata order)
    internal
    override(MultiUser, MultiUserAaveV2Lender)
    returns (uint missing)
  {
    // puts amount inbound_tkn on AAVE
    missing = MultiUserAaveV2Lender.__put__(amount, order);
  }

  function __get__(uint amount, ML.SingleOrder calldata order)
    internal
    override(MultiUser, MultiUserAaveV2Lender)
    returns (uint)
  {
    // gets tokens from AAVE's owner deposit -- will transfer aTokens from owner first
    return MultiUserAaveV2Lender.__get__(amount, order);
  }

  function __posthookSuccess__(ML.SingleOrder calldata order)
    internal
    override(MangroveOffer, MultiUserPersistent)
  {
    // reposting residual if possible
    MultiUserPersistent.__posthookSuccess__(order);
  }
}
