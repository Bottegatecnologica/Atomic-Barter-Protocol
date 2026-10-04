import Button from "./ui/button"
import { SEPOLIA_ESCROW } from "../lib/sepolia"
import { formatTokenAmount, type Shelf } from "../lib/shelf"
import { isAddress } from "ethers"

function ShelfCard({ title, detail, draggable, payload }: { title: string; detail: string; draggable: boolean; payload: string }) {
  return (
    <div
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return
        event.dataTransfer.setData("text/plain", payload)
        event.dataTransfer.effectAllowed = "copy"
      }}
      className={`rounded-xl border border-white/10 bg-black/40 px-3 py-3 ${draggable ? "cursor-grab active:cursor-grabbing" : "opacity-70"}`}
    >
      <p className="text-sm font-medium text-zinc-100">{title}</p>
      <p className="mt-1 font-mono text-xs text-violet-200">{detail}</p>
    </div>
  )
}

export function TestShelf({
  account,
  busy,
  canMintErc20,
  canMintNft,
  shelf,
  canDrag,
  onMintErc20,
  onMintNft,
}: {
  account: string | null
  busy: boolean
  canMintErc20: boolean
  canMintNft: boolean
  shelf: Shelf | null
  canDrag: boolean
  onMintErc20: () => void
  onMintNft: () => void
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="text-base font-semibold">Sepolia test assets</h2>
      <p className="mt-1 text-sm text-zinc-400">
        These tokens have no value. Creating one mints it to the connected wallet and fills the form below, so you can list it in the open trade.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || !account || !canMintErc20} onClick={onMintErc20}>
          Create test ERC-20
        </Button>
        <Button disabled={busy || !account || !canMintNft} onClick={onMintNft}>
          Create test NFT
        </Button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ShelfCard
          title={shelf ? shelf.symbol : "Test ERC-20"}
          detail={shelf ? formatTokenAmount(shelf.balance, shelf.decimals) : "Connect to see the balance"}
          draggable={Boolean(shelf && shelf.balance > 0n && canDrag)}
          payload={shelf && shelf.balance > 0n ? JSON.stringify({ kind: "ERC20", amount: shelf.balance.toString() }) : ""}
        />
        {(shelf?.nftIds ?? []).map((id) => (
          <ShelfCard
            key={id.toString()}
            title={`Test NFT #${id.toString()}`}
            detail="Drag onto You give"
            draggable={canDrag}
            payload={JSON.stringify({ kind: "ERC721", tokenId: id.toString() })}
          />
        ))}
      </div>
      {account && shelf && shelf.nftIds.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500">No test NFTs in this wallet yet. Create one, then drag it onto an open trade.</p>
      )}
      {!isAddress(SEPOLIA_ESCROW) && (
        <p className="mt-3 text-sm text-amber-100">The Sepolia contracts are not in this build yet.</p>
      )}
    </section>
  )
}
