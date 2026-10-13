#!/usr/bin/env node
/**
 * READ-ONLY export of Firestore + Firebase Auth to local JSON.
 *
 *   npm i --no-save firebase-admin   (v11+; modular imports)
 *   export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/service-account.json   # never commit this file
 *   node scripts/export-firestore.js --out=./export
 *
 * It only calls get()/listUsers(). Password hashes and salts from Firebase Auth are
 * deliberately NOT exported: customers set a new password via "Forgot password".
 * The export contains personal data (emails, phone numbers, addresses) and the old
 * plaintext admin passwords — store it encrypted and delete it after cutover.
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const out = path.resolve(args.out ?? "./export");

// firebase-admin >= 10 exposes modular entry points; the old `import admin from 'firebase-admin'`
// default export is not available under ESM in current versions.
let initializeApp, applicationDefault, getFirestore, getAuth;
try {
  ({ initializeApp, applicationDefault } = await import("firebase-admin/app"));
  ({ getFirestore } = await import("firebase-admin/firestore"));
  ({ getAuth } = await import("firebase-admin/auth"));
} catch (err) {
  console.error(
    `firebase-admin could not be loaded (${err.code ?? err.message}). Run: npm i --no-save firebase-admin`,
  );
  process.exit(2);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    "Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file path.",
  );
  process.exit(2);
}
if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  console.error(
    `GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`,
  );
  process.exit(2);
}
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const COLLECTIONS = [
  "manufacturer",
  "manufacturerType",
  "tags",
  "category",
  "region",
  "countries",
  "currency",
  "payment",
  "delivery",
  "admins",
  "users",
  "subscribers",
  "carts",
];

function serialize(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toDate === "function" && "seconds" in v)
    return { _seconds: v.seconds, _nanoseconds: v.nanoseconds };
  if (
    typeof v.latitude === "number" &&
    typeof v.longitude === "number" &&
    Object.keys(v).length <= 4
  )
    return { _latitude: v.latitude, _longitude: v.longitude };
  if (v?.path && v?.firestore) return { __ref: v.path };
  if (Buffer.isBuffer(v)) return { __bytes: v.toString("base64") };
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, serialize(x)]),
    );
  return v;
}

try {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const counts = {};
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...serialize(d.data()) }));
    fs.writeFileSync(
      path.join(out, `${name}.json`),
      JSON.stringify(docs, null, 2),
      { mode: 0o600 },
    );
    counts[name] = docs.length;
  }

  const users = [];
  let token;
  do {
    const page = await getAuth().listUsers(1000, token);
    for (const u of page.users) {
      users.push({
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        phoneNumber: u.phoneNumber,
        disabled: u.disabled,
        emailVerified: u.emailVerified,
        metadata: {
          creationTime: u.metadata.creationTime,
          lastSignInTime: u.metadata.lastSignInTime,
        },
      });
    }
    token = page.pageToken;
  } while (token);
  fs.writeFileSync(
    path.join(out, "auth-users.json"),
    JSON.stringify(users, null, 2),
    { mode: 0o600 },
  );
  counts["auth-users"] = users.length;

  console.table(counts);
  console.log(`Exported to ${out} (file mode 600). Keep it private.`);
} catch (err) {
  console.error(`\nExport failed: ${err.message}`);
  if (/PERMISSION_DENIED|403/.test(err.message))
    console.error(
      "The service account lacks access. Re-download a key for this project (Firebase console > Project settings > Service accounts).",
    );
  if (/NOT_FOUND|5 NOT_FOUND/.test(err.message))
    console.error(
      "Firestore was not found for this project. Check the key belongs to the right Firebase project.",
    );
  process.exit(1);
}
