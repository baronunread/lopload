// Builds the real AppServices implementation against a real Host and a real
// (fresh) MinIO bucket, without mounting any UI — for tests that render a
// single component (SetupForm, Onboarding, TransferWidget, ...) rather than
// the whole AppShell. See appHarness.ts for the full-app equivalent.
//
// Still no fakes: this is the same createAppServices(createNodeHost())
// construction appHarness.ts does, just without the render() call, so a test
// can mount whatever piece of UI it actually needs against the same real
// wiring.
import { createAppServices, type Services } from "../../src/services/appServices";
import type { Host } from "../../src/services/host";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { bucketProbe, type BucketProbe } from "./bucketProbe";
import { freshBucket, type Bucket } from "./minio";
import { createNodeHost, type HostControl, type HostRecord } from "./nodeHost";

export interface ServiceHarnessOptions {
  /** Wrap the host's fetch — used by fault-injection tests (see faultyFetch.ts). */
  wrapFetch?: (inner: FetchFn) => FetchFn;
}

export interface ServiceHarness {
  services: Services;
  /** The underlying Host — for the rare test that needs to reach a layer
   * LoploadServices doesn't expose directly (e.g. writing a connection row
   * without a matching keychain entry, to reproduce a denied-prompt gap). */
  host: Host;
  bucket: BucketProbe;
  /** The fresh bucket's connection details/credentials, for building a
   * ConnectionDraft or a Connection that actually works against it. */
  bucketConnection: Bucket["connection"];
  credentials: Bucket["credentials"];
  control: HostControl;
  record: HostRecord;
  /** A real, empty directory on disk. */
  workdir: string;
  dispose(): Promise<void>;
}

export async function createServiceHarness(
  options: ServiceHarnessOptions = {},
): Promise<ServiceHarness> {
  const bucket = await freshBucket();
  const { host, record, control, workdir } = await createNodeHost();
  if (options.wrapFetch) host.fetch = options.wrapFetch(host.fetch);

  const services = createAppServices(host);

  return {
    services,
    host,
    bucket: bucketProbe(bucket.client, bucket.name),
    bucketConnection: bucket.connection,
    credentials: bucket.credentials,
    control,
    record,
    workdir,
    async dispose() {
      await services.dispose();
    },
  };
}
