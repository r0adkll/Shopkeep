import { ApiError } from "../api";

export type PersonalizationQuestion = {
  type: "text" | "dropdown" | "file";
  questionText: string;
  instructions?: string | null;
  required: boolean;
  maxChars?: number | null;
  options: string[];
};

export type Personalization = {
  questions: PersonalizationQuestion[];
  feeMinor?: number | null;
  extraLaborMinutes?: number | null;
};

export type AxisValue = {
  materialId: number | null;
  offered: boolean;
  platformSku?: string | null;
  priceOverrideMinor?: number | null;
  designId?: number | null;
  variantId?: number | null;
  overrideKey?: string | null;
  displayLabel?: string | null;
};

export type Axis = { displayName: string; productSlotPosition: number; values: AxisValue[]; valueSource?: string };

export type Extra = { materialId: number; quantity: number; basis: "per_order" | "per_unit" };

export type ListingInput = {
  productId: number;
  title: string;
  description: string;
  state: "draft" | "active" | "inactive";
  basePriceMinor: number;
  currency: string;
  quantity: number;
  skuMode: "per_combination" | "per_primary" | "listing_level";
  listingSku?: string | null;
  packagingProfileId: number | null;
  tags: string[];
  materialsList: string[];
  shopSection: string | null;
  personalization: Personalization | null;
  imageDocumentIds: number[];
  axes: Axis[];
  extras: Extra[];
  disabledSkus: string[];
};

export type ConfigurationRow = {
  sku: string;
  selections: { slotIndex: number; slotName: string; materialId: number; materialName: string; color: string | null }[];
  enabled: boolean;
};

export type Listing = {
  id: number;
  input: ListingInput;
  syncState: string;
  platformState: string | null;
  etsyListingId: string | null;
  archived: boolean;
  configurations: ConfigurationRow[];
};

export type Band = { minQty: number; maxQty?: number | null; kind: "stocked" | "adhoc"; materials: Extra[] };
export type PackagingProfile = { id: number; name: string; bands: Band[]; listingCount: number };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message: string }).message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const listingsApi = {
  list: (includeArchived = false) => req<Listing[]>(`/listings?includeArchived=${includeArchived}`),
  delete: async (id: number) => {
    const r = await fetch(`/api/v1/listings/${id}`, { method: "DELETE" });
    if (!r.ok) {
      let message = r.status === 404 ? "Endpoint missing — restart the dev server?" : r.statusText;
      try {
        message = ((await r.json()) as { message: string }).message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(r.status, message);
    }
  },
  get: (id: number) => req<Listing>(`/listings/${id}`),
  create: (input: ListingInput) => req<Listing>("/listings", { method: "POST", body: JSON.stringify(input) }),
  update: (id: number, input: ListingInput) =>
    req<Listing>(`/listings/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  archive: (id: number, archived: boolean) =>
    req<Listing>(`/listings/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  profiles: () => req<PackagingProfile[]>("/packaging-profiles"),
  createProfile: (name: string, bands: Band[]) =>
    req<PackagingProfile>("/packaging-profiles", { method: "POST", body: JSON.stringify({ name, bands }) }),
  updateProfile: (id: number, name: string, bands: Band[]) =>
    req<PackagingProfile>(`/packaging-profiles/${id}`, { method: "PUT", body: JSON.stringify({ name, bands }) }),
};
