import { Wallet2 } from "lucide-react"
import Button from "./ui/button"
import { SEPOLIA_CHAIN_ID } from "../lib/sepolia"

export function SepoliaBanner({
  account,
  chainId,
  onSwitch,
}: {
  account: string | null
  chainId: number | null
  onSwitch: () => void
}) {
  const onSepolia = chainId === SEPOLIA_CHAIN_ID
  return (
    <>
      <div className={`sticky top-0 z-20 border-b px-6 py-3 ${onSepolia || chainId === null ? "border-violet-300/40 bg-violet-700 text-white" : "border-red-300/40 bg-red-700 text-white"}`}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.22em]">SEPOLIA TESTNET</p>
            <p className="text-sm text-white/90">Chain ID {SEPOLIA_CHAIN_ID}. These assets have no value. This page cannot see a wallet that is on another network.</p>
          </div>
          {account && chainId !== null && !onSepolia && (
            <Button onClick={onSwitch}>Switch wallet to Sepolia</Button>
          )}
        </div>
      </div>
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-400/15 text-amber-300">
              <Wallet2 className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Atomic Barter</h1>
              <p className="text-xs text-violet-200">Sepolia only. Both sides must accept the same list.</p>
            </div>
          </div>
          <Button onClick={onSwitch}>{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}</Button>
        </div>
      </header>
    </>
  )
}
