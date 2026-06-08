import { useState } from "react";
import { Crosshair, MapPin, Plus, Trash2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTools } from "@/state/tools";
import { cn, fmt } from "@/lib/utils";

export function HistoryPanel() {
  const {
    mode, setMode,
    historyItems, selectedHistoryId, setSelectedHistoryId,
    addHistoryNote, updateHistoryItem, removeHistoryItem, focusMap,
  } = useTools();

  const placing = mode === "place-history-pin";
  const pins = historyItems.filter((h) => h.lat != null && h.lon != null);
  const notes = historyItems.filter((h) => h.lat == null && h.lon == null);

  return (
    <Tabs defaultValue="pins" className="w-full">
      <TabsList className="mb-4 grid w-full grid-cols-2">
        <TabsTrigger value="pins">Pins</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>

      <TabsContent value="pins" className="mt-0 space-y-4">
        <section>
          <SectionHead>Map pointers</SectionHead>
          <p className="text-body-sm mb-3">
            Drop pins on the map to mark places you want to revisit. Each pin can have a title and note.
          </p>
          <Button
            variant={placing ? "secondary" : "default"}
            size="sm"
            className="w-full"
            onClick={() => setMode(placing ? "idle" : "place-history-pin")}
          >
            <Crosshair className="mr-2 h-3.5 w-3.5" />
            {placing ? "Click map… (Esc to cancel)" : "Drop pin on map"}
          </Button>
        </section>

        <section className="border-t border-border pt-4">
          <SectionHead>Saved pins ({pins.length})</SectionHead>
          {pins.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">No pins yet. Use the button above to place one.</p>
          ) : (
            <ul className="space-y-2">
              {pins.map((pin) => (
                <PinRow
                  key={pin.id}
                  title={pin.title}
                  lat={pin.lat!}
                  lon={pin.lon!}
                  body={pin.body}
                  selected={selectedHistoryId === pin.id}
                  onSelect={() => setSelectedHistoryId(pin.id)}
                  onFocus={() => focusMap(pin.lat!, pin.lon!)}
                  onTitleChange={(t) => updateHistoryItem(pin.id, { title: t })}
                  onRemove={() => removeHistoryItem(pin.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </TabsContent>

      <TabsContent value="notes" className="mt-0 space-y-4">
        <section>
          <SectionHead>Notes</SectionHead>
          <p className="text-body-sm mb-3">
            Journal observations, briefing notes, or site comments. Notes can be linked to a pin or stand alone.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => addHistoryNote()}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            New note
          </Button>
        </section>

        <section className="border-t border-border pt-4">
          {notes.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">No notes yet.</p>
          ) : (
            <ul className="space-y-3">
              {notes.map((item) => (
                <NoteCard
                  key={item.id}
                  item={item}
                  selected={selectedHistoryId === item.id}
                  onSelect={() => setSelectedHistoryId(item.id)}
                  onFocus={item.lat != null && item.lon != null ? () => focusMap(item.lat!, item.lon!) : undefined}
                  onTitleChange={(t) => updateHistoryItem(item.id, { title: t })}
                  onBodyChange={(b) => updateHistoryItem(item.id, { body: b })}
                  onRemove={() => removeHistoryItem(item.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </TabsContent>
    </Tabs>
  );
}

function PinRow({
  title, lat, lon, body, selected,
  onSelect, onFocus, onTitleChange, onRemove,
}: {
  title: string;
  lat: number;
  lon: number;
  body: string;
  selected: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onTitleChange: (t: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5 transition-colors",
        selected ? "border-foreground/25 bg-foreground/5" : "border-border bg-secondary/30",
      )}
    >
      <button type="button" className="w-full text-left" onClick={onSelect}>
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => { onTitleChange(draft.trim() || title); setEditing(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onTitleChange(draft.trim() || title);
                    setEditing(false);
                  }
                }}
                className="h-7 text-xs"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className="text-body-sm font-medium text-foreground"
                onDoubleClick={(e) => { e.stopPropagation(); setDraft(title); setEditing(true); }}
              >
                {title}
              </div>
            )}
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {fmt(lat, 4)}°, {fmt(lon, 4)}°
            </div>
            {body && (
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{body}</p>
            )}
          </div>
        </div>
      </button>
      <div className="mt-2 flex gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 flex-1 text-[11px]" onClick={onFocus}>
          Show on map
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${title}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

function NoteCard({
  item, selected, onSelect, onFocus, onTitleChange, onBodyChange, onRemove,
}: {
  item: { id: string; title: string; body: string; lat: number | null; lon: number | null; createdAt: number };
  selected: boolean;
  onSelect: () => void;
  onFocus?: () => void;
  onTitleChange: (t: string) => void;
  onBodyChange: (b: string) => void;
  onRemove: () => void;
}) {
  const hasPin = item.lat != null && item.lon != null;
  const date = new Date(item.createdAt).toLocaleDateString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <li
      className={cn(
        "rounded-lg border p-3 transition-colors",
        selected ? "border-foreground/25 bg-foreground/5" : "border-border bg-secondary/30",
      )}
      onClick={onSelect}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Input
          value={item.title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="h-8 flex-1 text-xs font-medium"
          onClick={(e) => e.stopPropagation()}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label="Delete note"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <textarea
        value={item.body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Write your note…"
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-body-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{date}</span>
        {hasPin ? (
          <button
            type="button"
            className="flex items-center gap-1 text-foreground hover:underline"
            onClick={(e) => { e.stopPropagation(); onFocus?.(); }}
          >
            <MapPin className="h-3 w-3" />
            Linked pin
          </button>
        ) : (
          <span>Standalone note</span>
        )}
      </div>
    </li>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span className="text-section shrink-0">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
