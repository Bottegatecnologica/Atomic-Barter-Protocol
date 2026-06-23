import React, { useState } from 'react'
import { Wallet2 } from 'lucide-react'

interface Asset {
  type: 'NFT' | 'TOKEN'
  address: string
  tokenId?: string
  amount?: string
}

interface TradeState {
  counterpartyAddress: string
  tradeId: string | null
  assets: {
    initiator: Asset[]
    counterparty: Asset[]
  }
}

export function TradeInterface() {
  const [state, setState] = useState<TradeState>({
    counterpartyAddress: '',
    tradeId: null,
    assets: {
      initiator: [],
      counterparty: []
    }
  })

  return (
    <div className="container mx-auto p-4">
      <div className="flex items-center gap-2 mb-6">
        <Wallet2 className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Trade NFTs & Tokens</h1>
      </div>
      
      {/* Qui aggiungeremo i componenti per:
          - Inserire l'indirizzo della controparte
          - Aggiungere NFT
          - Aggiungere token
          - Visualizzare gli asset nel trade
      */}
    </div>
  )
}
