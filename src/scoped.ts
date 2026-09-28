import { CID_PATTERN } from "./cid.ts";
import type { Config } from "./config.ts";
import { isValidCollection, isValidRkey, type RecordInfo } from "./entrypoints/record.ts";
import { collectionMatches } from "./jetstream.ts";
import { parseBlobPath } from "./path.ts";
import { CACHE_CONTROL, blobTags, errorResponse, recordTag, versionTag } from "./response.ts";

export interface ScopedRef {
	did: string;
	collection: string;
	rkey: string;
	recordCid?: string;
	cid: string;
}

export type ScopedPath =
	| ({ kind: "scoped" } & ScopedRef)
	| { kind: "redirect"; location: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

/**
 * `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}`, with the legacy
 * `/r/{did}/{collection}/{rkey}/{blobCid}` form retained for compatibility.
 */
export function parseScopedPath(pathname: string): ScopedPath {
	const segments = pathname.split("/");
	if (
		(segments.length !== 6 && segments.length !== 7) ||
		segments[0] !== "" ||
		segments[1] !== "r" ||
		segments.at(-1) === ""
	)
		return { kind: "unknown" };
	const rawDid = segments[2]!;
	const collection = segments[3]!;
	const rkey = segments[4]!;
	const rawRecordCid = segments.length === 7 ? segments[5]! : undefined;
	const rawCid = segments.at(-1)!;
	if (!isValidCollection(collection) || !isValidRkey(rkey)) return { kind: "invalid" };
	const blob = parseBlobPath(`/${rawDid}/${rawCid}`);
	if (blob.kind !== "blob" && blob.kind !== "redirect") return { kind: "invalid" };
	const canonicalBlob = blob.kind === "blob" ? `/${blob.did}/${blob.cid}` : blob.location;
	const [did, cid] = canonicalBlob.slice(1).split("/") as [string, string];
	let recordCid: string | undefined;
	if (rawRecordCid !== undefined) {
		const record = parseBlobPath(`/${did}/${rawRecordCid}`);
		if (record.kind !== "blob" && record.kind !== "redirect") return { kind: "invalid" };
		const canonicalRecord =
			record.kind === "blob" ? `/${record.did}/${record.cid}` : record.location;
		recordCid = canonicalRecord.slice(canonicalRecord.lastIndexOf("/") + 1);
	}
	const canonical = `/r/${did}/${collection}/${rkey}/${recordCid ? `${recordCid}/` : ""}${cid}`;
	if (canonical !== pathname) return { kind: "redirect", location: canonical };
	if (!CID_PATTERN.test(cid)) return { kind: "invalid" };
	return {
		kind: "scoped",
		did,
		collection,
		rkey,
		...(recordCid ? { recordCid } : {}),
		cid,
	};
}

export type Admission = { kind: "admit"; tags: string[] } | { kind: "deny"; response: Response };

/**
 * Forward membership check (SPEC.md §8b): the collection must be
 * allowlisted and the requested cid must be among the record's blob refs.
 * Denials are cached a day and tagged so a record purge clears them.
 */
export async function admit(
	ref: ScopedRef,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
): Promise<Admission> {
	const record = recordTag(ref.did, ref.collection, ref.rkey);
	const tags = [...blobTags(ref.did, ref.cid), record, versionTag(env)];
	if (!collectionMatches(ref.collection, config.scopedCollections)) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 403,
				cacheControl: CACHE_CONTROL.day,
				tags,
				message: "Collection is not served by this proxy",
			}),
		};
	}
	const response = await ctx.exports.Record.fetch(
		`http://record/record/${ref.did}/${ref.collection}/${ref.rkey}`,
	);
	if (response.status === 404) {
		await response.body?.cancel();
		return {
			kind: "deny",
			response: errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "Record not found",
			}),
		};
	}
	if (!response.ok) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: `Record returned ${response.status}: ${await response.text()}`,
			}),
		};
	}
	const info = (await response.json()) as RecordInfo;
	if (ref.recordCid !== undefined && info.cid !== ref.recordCid) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "Record revision not found",
			}),
		};
	}
	if (!info.blobs.includes(ref.cid)) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 403,
				cacheControl: CACHE_CONTROL.day,
				tags,
				message: "Blob is not referenced by this record",
			}),
		};
	}
	if (info.authenticatedBlobs.includes(ref.cid)) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 403,
				cacheControl: CACHE_CONTROL.noStore,
				message: "Authenticated blobs are not served by this proxy",
			}),
		};
	}
	return { kind: "admit", tags: [record] };
}
