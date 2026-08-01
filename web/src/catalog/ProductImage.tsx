import { MaterialIcon } from "../inventory/MaterialIcon";
import { documentUrl } from "./api";

/** Product image with a consistent placeholder (the hand-drawn cube glyph)
 *  so cards and editors keep their shape when no photo is set. */
export function ProductImage({
  imageDocumentId,
  size = 64,
  className = "",
}: {
  imageDocumentId: number | null;
  size?: number;
  className?: string;
}) {
  return imageDocumentId ? (
    <img
      src={documentUrl(imageDocumentId)}
      alt=""
      style={{ width: size, height: size }}
      className={`flex-none rounded-lg border border-line object-cover ${className}`}
    />
  ) : (
    <span
      style={{ width: size, height: size }}
      className={`flex flex-none items-center justify-center rounded-lg border border-line bg-panel2 text-mut ${className}`}
      aria-hidden="true"
    >
      <MaterialIcon category="product" size={Math.round(size * 0.45)} />
    </span>
  );
}
