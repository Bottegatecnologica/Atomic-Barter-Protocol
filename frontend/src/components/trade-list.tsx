import type { KnownTrade } from "../lib/shelf"

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function TradeList({
  account,
  trades,
  checkedAt,
  onOpen,
}: {
  account: string | null
  trades: KnownTrade[]
  checkedAt: number | null
  onOpen: (tradeId: string) => void
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Trades with you</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Sepolia logs from the last few weeks where your wallet is one of the two sides. The list refreshes while this tab stays open.
          </p>
        </div>
        {checkedAt && (
          <p className="text-xs text-violet-200">Checked {new Date(checkedAt).toLocaleTimeString()}</p>
        )}
      </div>
      {!account ? (
        <p className="mt-4 text-sm text-zinc-500">Connect a wallet on Sepolia to see them.</p>
      ) : trades.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">No trades with this wallet in the recent logs.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {trades.map((item) => {
            const other = account.toLowerCase() === item.initiator.toLowerCase() ? item.counterparty : item.initiator
            const label = item.cancelled ? "Cancelled" : item.executed ? "Settled" : "Open"
            return (
              <li key={item.tradeId}>
                <button
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-left hover:border-violet-300/50"
                  onClick={() => onOpen(item.tradeId)}
                >
                  <span className="text-sm text-zinc-100">
                    {account.toLowerCase() === item.initiator.toLowerCase() ? "You opened it" : "They opened it"} · {shortAddress(other)}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs ${item.cancelled ? "bg-white/10 text-zinc-300" : item.executed ? "bg-emerald-400/15 text-emerald-300" : "bg-violet-400/20 text-violet-100"}`}>
                    {label}{item.cancelled ? "" : ` · version ${item.version.toString()}`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
