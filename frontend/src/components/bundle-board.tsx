import type { DragEvent } from "react"
import Button from "./ui/button"
import { boxKey, isSchrodingerBox, type BoxInside } from "../lib/box"
import type { ListedAsset } from "../lib/escrow"

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatAsset(asset: ListedAsset) {
  if (asset.assetType === 1 && isSchrodingerBox(asset.contractAddress)) {
    return `Schrödinger's Box #${asset.tokenId.toString()}`
  }
  if (asset.assetType === 1) {
    return `NFT ${shortAddress(asset.contractAddress)} #${asset.tokenId.toString()}`
  }
  return `${asset.amount.toString()} of token ${shortAddress(asset.contractAddress)}`
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`rounded-full px-3 py-1 ${on ? "bg-emerald-400/15 text-emerald-300" : "bg-white/5 text-zinc-400"}`}>
      {label}: {on ? "yes" : "not yet"}
    </span>
  )
}

function AssetColumn({
  title,
  hint,
  assets,
  insides,
  onRemove,
  drop,
}: {
  title: string
  hint?: string
  assets: ListedAsset[]
  insides?: Map<string, BoxInside>
  onRemove?: (index: number) => void
  drop?: {
    active: boolean
    onDragOver: (event: DragEvent) => void
    onDragLeave: () => void
    onDrop: (event: DragEvent) => void
  }
}) {
  return (
    <div
      className={`rounded-xl border bg-black/30 p-4 ${drop?.active ? "border-dashed border-violet-300 bg-violet-400/10" : "border-white/10"}`}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
    >
      <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
      {assets.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {assets.map((asset, index) => {
            const inside = insides?.get(boxKey(asset.contractAddress, asset.tokenId))
            return (
              <li key={`${asset.contractAddress}-${asset.tokenId}-${asset.amount}-${index}`} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.04] px-3 py-2">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-zinc-200">{formatAsset(asset)}</span>
                  {inside && (
                    <p className={`mt-1 text-xs ${inside.changed ? "text-amber-200" : "text-zinc-400"}`}>
                      {inside.lines.join(" · ")}
                    </p>
                  )}
                  {inside?.changed && (
                    <p className="mt-1 text-xs font-medium text-amber-200">The contents of this box changed after it was listed, or it is no longer sealed.</p>
                  )}
                  {inside?.unread && (
                    <p className="mt-1 text-xs text-amber-200">Could not check whether this box changed after it was listed.</p>
                  )}
                </div>
                {onRemove && (
                  <Button variant="ghost" onClick={() => onRemove(index)}>
                    Remove
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function BundleBoard({
  trade,
  youApproved,
  theyApproved,
  bundleSource,
  contentChanged,
  busy,
  myAssets,
  theirAssets,
  insides,
  dropOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemove,
  onApprove,
  onCancel,
}: {
  trade: { executed: boolean; version: bigint; deadline: bigint } | null
  youApproved: boolean
  theyApproved: boolean
  bundleSource: "storage" | "events" | null
  contentChanged: boolean
  busy: boolean
  myAssets: ListedAsset[]
  theirAssets: ListedAsset[]
  insides: Map<string, BoxInside>
  dropOver: boolean
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent) => void
  onRemove?: (index: number) => void
  onApprove: () => void
  onCancel: () => void
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#101218] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">What is being traded</h2>
          <p className="mt-1 text-sm text-zinc-400">
            {trade
              ? "Check both lists before you accept. If someone adds or removes an asset, you have to accept again."
              : "This shows what you give and what you receive. Create a trade first, or open one with its code."}
          </p>
        </div>
        {trade && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${trade.executed ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-200"}`}>
            {trade.executed ? "Settled" : "Open"} · version {trade.version.toString()}
          </span>
        )}
      </div>

      {trade && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Pill on={youApproved} label="You accepted" />
          <Pill on={theyApproved} label="They accepted" />
          <span className="rounded-full border border-white/10 px-3 py-1 text-zinc-300">
            Expires {new Date(Number(trade.deadline) * 1000).toLocaleString()}
          </span>
        </div>
      )}

      {trade && !trade.executed && (
        <p className="mt-4 text-sm text-zinc-400">
          An NFT is sent with a normal transfer. If the other side is a contract that cannot send NFTs onward, the NFT can get stuck there.
        </p>
      )}

      {bundleSource === "events" && (
        <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          This trade is already settled. The contract cleared its lists, so the assets below are the ones that were added and not removed.
        </p>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <AssetColumn
          title="You give"
          hint={trade && !trade.executed ? "Drop a test asset here." : undefined}
          assets={myAssets}
          insides={insides}
          onRemove={onRemove}
          drop={trade && !trade.executed ? { active: dropOver, onDragOver, onDragLeave, onDrop } : undefined}
        />
        <AssetColumn title="You receive" assets={theirAssets} insides={insides} />
      </div>

      {contentChanged && (
        <p className="mt-4 rounded-xl border border-amber-300/40 bg-amber-400/15 p-3 text-sm text-amber-50">
          The contents of a box in this trade changed after it was listed, or the box is no longer sealed. Accept stays off. Remove that box and list it again.
        </p>
      )}

      {trade && !trade.executed && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy || contentChanged} onClick={onApprove}>
            I accept version {trade.version.toString()}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel trade
          </Button>
        </div>
      )}
    </section>
  )
}
