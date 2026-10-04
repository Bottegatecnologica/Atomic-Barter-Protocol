import Button from "./ui/button"
import { Field, fieldClass } from "./field"

export function TradeForms({
  account,
  busy,
  counterparty,
  deadlineInput,
  deadlineMax,
  escrowAddress,
  tradeId,
  onCounterparty,
  onDeadline,
  onEscrow,
  onTradeId,
  onCreate,
  onShow,
}: {
  account: string | null
  busy: boolean
  counterparty: string
  deadlineInput: string
  deadlineMax: string
  escrowAddress: string
  tradeId: string
  onCounterparty: (value: string) => void
  onDeadline: (value: string) => void
  onEscrow: (value: string) => void
  onTradeId: (value: string) => void
  onCreate: () => void
  onShow: () => void
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-base font-semibold">New trade</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Enter the other person's address and how long the offer stays open. You need a connected wallet.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Who you trade with" hint="Their wallet address, not yours.">
            <input
              className={`${fieldClass} font-mono`}
              value={counterparty}
              onChange={(event) => onCounterparty(event.target.value.trim())}
              placeholder="0x…"
            />
          </Field>
          <Field label="Expires" hint="Seven days is the default. Thirty days is the longest.">
            <input
              className={fieldClass}
              type="datetime-local"
              value={deadlineInput}
              max={deadlineMax}
              onChange={(event) => onDeadline(event.target.value)}
            />
          </Field>
          <Button disabled={busy || !account} onClick={onCreate}>
            Create trade
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-base font-semibold">Existing trade</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Paste the contract address and the code the other person sent you. If you created the trade, the code appears here after your wallet confirms.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Atomic Barter contract" hint="The contract address on this network. Whoever published it can give it to you.">
            <input
              className={`${fieldClass} font-mono`}
              value={escrowAddress}
              onChange={(event) => onEscrow(event.target.value.trim())}
              placeholder="0x…"
            />
          </Field>
          <div>
            <Field label="Trade code" hint="A long value that starts with 0x.">
              <input
                className={`${fieldClass} font-mono`}
                value={tradeId}
                onChange={(event) => onTradeId(event.target.value.trim())}
                placeholder="0x…"
              />
            </Field>
            <div className="mt-3">
              <Button variant="outline" disabled={busy || !account} onClick={onShow}>
                Show trade
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
