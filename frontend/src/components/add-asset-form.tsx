import { ShieldAlert } from "lucide-react"
import Button from "./ui/button"

export function AddAssetForm({
  kind,
  address,
  tokenId,
  amount,
  unknown,
  acknowledged,
  busy,
  executed,
  canAdd,
  onKind,
  onAddress,
  onTokenId,
  onAmount,
  onAck,
  onTrust,
  onAdd,
}: {
  kind: "ERC20" | "ERC721"
  address: string
  tokenId: string
  amount: string
  unknown: boolean
  acknowledged: boolean
  busy: boolean
  executed: boolean
  canAdd: boolean
  onKind: (kind: "ERC20" | "ERC721") => void
  onAddress: (value: string) => void
  onTokenId: (value: string) => void
  onAmount: (value: string) => void
  onAck: (value: boolean) => void
  onTrust: () => void
  onAdd: () => void
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="text-base font-semibold">Add an asset</h2>
      <p className="mt-1 text-sm text-zinc-400">
        It goes on the You give list. An NFT needs the token number. An ERC-20 needs the amount in the token's smallest unit, such as wei.
      </p>
      <div className="mt-4 flex gap-2">
        <Button variant={kind === "ERC721" ? "default" : "outline"} onClick={() => onKind("ERC721")}>
          NFT
        </Button>
        <Button variant={kind === "ERC20" ? "default" : "outline"} onClick={() => onKind("ERC20")}>
          ERC-20
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input
          className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70 sm:col-span-2"
          value={address}
          onChange={(event) => onAddress(event.target.value.trim())}
          placeholder="Token address, 0x…"
        />
        {kind === "ERC721" ? (
          <input
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70"
            value={tokenId}
            onChange={(event) => onTokenId(event.target.value)}
            placeholder="NFT number"
          />
        ) : (
          <input
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            placeholder="Amount, smallest unit"
          />
        )}
      </div>
      {unknown && (
        <div className="mt-3 space-y-3 rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          <p className="flex gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This token is not one you have already accepted. It can lie about how many you hold, or who owns an NFT, and the trade cannot tell.
            </span>
          </p>
          <label className="flex items-start gap-2 text-amber-50">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(event) => onAck(event.target.checked)}
            />
            I checked it. It is fine for this trade.
          </label>
          <Button variant="outline" onClick={onTrust}>
            Remember it on this computer
          </Button>
        </div>
      )}
      <div className="mt-3">
        <Button disabled={busy || executed || !canAdd} onClick={onAdd}>
          Add it to my list
        </Button>
      </div>
    </section>
  )
}
