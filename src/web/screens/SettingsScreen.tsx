import {
  Blocks,
  BookOpen,
  FileText,
  Globe,
  HardDrive,
  type LucideIcon,
  Puzzle,
  Server,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LibraryPayload } from "../../server/libraryContract";
import { fileSize } from "../format";
import type { BucketStatus, StatusRead } from "../useBucketStatus";

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.06)] ring-1 ring-line">
      <header className="flex items-start gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted">{description}</p>
        </div>
      </header>
      <div className="mt-4 pl-[3.375rem] text-sm">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.8125rem]">{children}</span>;
}

function Ready({ ready, yes, no }: { ready: boolean; yes: string; no: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium ${ready ? "text-filed" : "text-red-700"}`}
    >
      <span className={`h-2 w-2 rounded-full ${ready ? "bg-green-600" : "bg-red-600"}`} />
      {ready ? yes : no}
    </span>
  );
}

const PROVENANCE_FIELDS = [
  ["PDF URL", "the address the PDF bytes came from"],
  ["Source page", "the page that linked to the PDF"],
  ["Capture time", "when the bucket first stored it"],
  ["Original SHA-256", "the hash of the bytes as downloaded"],
  ["Title", "the title the capture offered"],
] as const;

type Foundation = { icon: LucideIcon; name: string; role: string; detail: string };

function foundations(status: BucketStatus): Foundation[] {
  return [
    {
      icon: FileText,
      name: "PDF renderer",
      role: "PDF.js",
      detail: `Prebuilt viewer ${status.settings.pdfjsVersion}`,
    },
    {
      icon: Puzzle,
      name: "Browser extension",
      role: "WXT",
      detail: "One source tree, Chrome and Firefox builds",
    },
    {
      icon: SquareTerminal,
      name: "Plugins",
      role: "Commands",
      detail: "Extraction and resolvers with JSON manifests",
    },
    {
      icon: BookOpen,
      name: "Zotero Connector",
      role: "Unmodified",
      detail: "Saves reader pages from any browser tab",
    },
    { icon: Blocks, name: "Window", role: "Tauri", detail: "Loads this server's address" },
  ];
}

function Sections({ payload, status }: { payload: LibraryPayload; status: BucketStatus }) {
  const stored = payload.items.reduce((total, item) => total + item.file.sizeBytes, 0);
  return (
    <>
      <Section
        icon={Globe}
        title="Browser Capture"
        description="Chrome and Firefox extensions intercept PDF links and hand the bytes to the bucket."
      >
        <Facts
          rows={[
            [
              "Capture endpoint",
              <Ready
                key="c"
                ready={status.capabilities.capture}
                yes="Accepting captures"
                no="Not accepting captures"
              />,
            ],
            [
              "Chrome and Firefox",
              "Capture is switched on or off in each extension's own options page.",
            ],
          ]}
        />
      </Section>
      <Section
        icon={HardDrive}
        title="Offline Cache"
        description="Every PDF is a local file under the bucket folder; the library is read from those files."
      >
        <Facts
          rows={[
            ["Library folder", <Mono key="r">{status.settings.root}</Mono>],
            ["Stored", `${payload.items.length.toLocaleString()} PDFs (${fileSize(stored)})`],
            [
              "Collections, tags and notes",
              <Mono key="o">{status.settings.organizationFile}</Mono>,
            ],
          ]}
        />
      </Section>
      <Section
        icon={ShieldCheck}
        title="Provenance & Recovery"
        description="Each stored PDF carries where it came from inside the file, so the library can be rebuilt from the files alone."
      >
        <Facts rows={PROVENANCE_FIELDS.map(([label, meaning]) => [label, meaning])} />
      </Section>
      <Section
        icon={BookOpen}
        title="Zotero Integration"
        description="Zotero stays the citation store; the bucket writes to it only when you send an item or press the Zotero Connector."
      >
        <Facts
          rows={[
            [
              "Reader pages",
              "Carry citation metadata, so the Zotero Connector saves any of them with its PDF attached.",
            ],
          ]}
        />
      </Section>
      <Section
        icon={Server}
        title="Server"
        description="The window, the extensions and the plugins all talk to this address."
      >
        <Facts
          rows={[
            ["Address", <Mono key="a">{status.backend_url}</Mono>],
            ["Status", <Ready key="s" ready={status.ready} yes="Ready" no="Not ready" />],
            ["Version", `${status.service.name} ${status.service.version}`],
          ]}
        />
      </Section>
      <section aria-label="Embedded Foundations" className="pt-2">
        <h2 className="text-base font-semibold">Embedded Foundations</h2>
        <p className="text-sm text-muted">PDF Bucket is wiring around existing tools.</p>
        <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          {foundations(status).map(({ icon: Icon, name, role, detail }) => (
            <li key={name} className="rounded-xl bg-white p-4 ring-1 ring-line">
              <Icon aria-hidden className="h-5 w-5 text-accent" />
              <p className="mt-2 text-sm font-semibold">{name}</p>
              <p className="text-sm text-ink">{role}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default function SettingsScreen({
  payload,
  read,
}: {
  payload: LibraryPayload;
  read: StatusRead;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-8 py-7">
        <header className="pb-2">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted">How PDF Bucket captures, stores and hands PDFs on.</p>
        </header>
        {read.kind === "checking" && (
          <p role="status" className="text-sm text-muted">
            Reading the bucket's status…
          </p>
        )}
        {read.kind === "failed" && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            The bucket status could not be read: {read.message}
          </p>
        )}
        {read.kind === "read" && <Sections payload={payload} status={read.status} />}
      </div>
    </div>
  );
}
