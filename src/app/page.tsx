import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  BookOpenText,
  Bot,
  Cloud,
  Database,
  FileText,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  ListChecks,
  MessageSquareText,
  Quote,
  ShieldCheck,
  Sparkles,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { ProductPreview } from "@/components/landing/ProductPreview";
import { Logo } from "@/components/Logo";
import { BRAND } from "@/lib/brand";
import { currentSession } from "@/server/auth/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `${BRAND.name} — ${BRAND.category}`, description: BRAND.description };

// Public landing page. Every capability listed here exists in the product; availability of AI
// models and cloud sources still depends on the administrator's configuration.

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: FileText, title: "Document Knowledge", text: "Upload PDF, Word, Excel, PowerPoint, text, Markdown and CSV files. Content is extracted, chunked and indexed for search." },
  { icon: Globe, title: "Website Scraping", text: "Crawl a website up to three links deep on the same site. Re-syncs update changed pages and skip the rest." },
  { icon: MessageSquareText, title: "AI Chat", text: "Ask questions and get structured answers grounded in your content, in English, Hindi or Gujarati." },
  { icon: Bot, title: "Multiple AI Models", text: "Answer with OpenAI, Google Gemini or Anthropic Claude, chosen by your administrator." },
  { icon: Quote, title: "Source Citations", text: "Every answer shows the document and page, or the web page, that supports it." },
  { icon: Cloud, title: "Cloud Integrations", text: "Sync a Google Drive or OneDrive folder once your administrator has connected it." },
];

const STEPS: { n: string; icon: LucideIcon; title: string; text: string }[] = [
  { n: "01", icon: Upload, title: "Connect your knowledge", text: "Upload documents or connect a website, Google Drive or OneDrive." },
  { n: "02", icon: Layers, title: "AI processes your knowledge", text: "Content is extracted, chunked and indexed with embeddings." },
  { n: "03", icon: MessageSquareText, title: "Ask anything", text: "Get answers grounded in your knowledge base, with sources." },
];

const SOURCES: { icon: LucideIcon; name: string; text: string; tint: string }[] = [
  { icon: FileText, name: "Documents", text: "PDF, DOCX, XLSX, PPTX, TXT, MD and CSV uploads.", tint: "bg-orange-50 text-orange-600" },
  { icon: Globe, name: "Websites", text: "Same-site crawling with duplicate detection.", tint: "bg-emerald-50 text-emerald-700" },
  { icon: HardDrive, name: "Google Drive", text: "Sync PDF, DOCX, TXT and MD files from a folder.", tint: "bg-blue-50 text-blue-700" },
  { icon: Cloud, name: "OneDrive", text: "Sync PDF, DOCX, TXT and MD files from a folder.", tint: "bg-sky-50 text-sky-700" },
];

const MODELS = [
  { name: "OpenAI", text: "GPT models through the OpenAI API." },
  { name: "Google Gemini", text: "Gemini models through the Google AI API." },
  { name: "Anthropic", text: "Claude models through the Anthropic API." },
];

const TRUST: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: ShieldCheck, title: "Grounded responses", text: "Answers use only retrieved content. If it isn't there, the assistant says so." },
  { icon: BookOpenText, title: "Source citations", text: "Each answer links back to the exact passages it used." },
  { icon: ListChecks, title: "Controlled knowledge access", text: "Choose which source each chat searches; features can be switched on or off." },
  { icon: KeyRound, title: "Secure API configuration", text: "AI provider keys stay in server settings and are never sent to the browser." },
];

function SectionHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold tracking-wide text-brand-600 uppercase">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {text && <p className="mt-3 text-base text-slate-600">{text}</p>}
    </div>
  );
}

export default async function LandingPage() {
  const signedIn = (await currentSession()) !== null;
  const year = new Date().getFullYear();

  return (
    <div id="top" className="landing min-h-dvh overflow-x-clip bg-white text-slate-900">
      <LandingHeader signedIn={signedIn} />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-[radial-gradient(ellipse_at_top_left,rgba(20,163,139,0.10),transparent_50%),radial-gradient(ellipse_at_bottom_right,rgba(37,99,235,0.08),transparent_50%)]">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-2 lg:pt-20 lg:pb-24">
            <div className="motion-safe:animate-[fade-up_0.6s_ease-out_both]">
              <p className="inline-flex items-center gap-1.5 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                <Sparkles className="h-3.5 w-3.5" /> {BRAND.category}
              </p>
              <h1 className="mt-5 text-4xl leading-[1.1] font-extrabold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
                Your knowledge.
                <br />
                <span className="bg-gradient-to-r from-brand-600 to-blue-600 bg-clip-text text-transparent">One intelligent assistant.</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
                Connect your documents, websites, and cloud files. Ask questions and get grounded answers with sources.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/login" className="btn justify-center bg-brand-600 px-5 py-3 text-base text-white shadow-lg shadow-brand-600/20 transition-transform hover:-translate-y-0.5 hover:bg-brand-700">
                  Try the AI Demo <ArrowRight className="h-4 w-4" />
                </Link>
                <a href="#features" className="btn btn-outline justify-center px-5 py-3 text-base">
                  Explore Features
                </a>
              </div>
              <p className="mt-4 text-sm text-slate-500">Demo account included — no setup needed.</p>
            </div>
            <div className="motion-safe:animate-[fade-up_0.7s_0.1s_ease-out_both]">
              <ProductPreview />
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/60 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="Features" title="Everything you need to build an AI knowledge assistant" />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <article key={f.title} className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
                  <div className="brand-gradient flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-sm">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-slate-900">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-20 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="How it works" title="From files to answers in three steps" />
            <ol className="mt-12 grid gap-4 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="rounded-2xl border border-slate-200 bg-white p-6">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-extrabold text-brand-600/25">{s.n}</span>
                    <s.icon className="h-6 w-6 text-brand-600" />
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-slate-900">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.text}</p>
                </li>
              ))}
            </ol>
            <div className="mx-auto mt-10 flex max-w-3xl flex-col items-center gap-2 rounded-2xl border border-navy-700 bg-navy-950 p-5 text-sm font-semibold text-slate-100 md:flex-row md:justify-between">
              {[
                { icon: FileText, label: "Sources" },
                { icon: Database, label: "Knowledge Base" },
                { icon: Bot, label: "AI" },
                { icon: Quote, label: "Answer + Sources" },
              ].map((step, i, all) => (
                <div key={step.label} className="flex flex-col items-center gap-2 md:flex-row">
                  <span className="flex items-center gap-2 rounded-xl border border-navy-600 bg-navy-850 px-3.5 py-2">
                    <step.icon className="h-4 w-4 text-orange-300" /> {step.label}
                  </span>
                  {i < all.length - 1 && (
                    <>
                      <ArrowDown className="h-4 w-4 text-slate-500 md:hidden" />
                      <ArrowRight className="hidden h-4 w-4 text-slate-500 md:ml-2 md:block" />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Sources */}
        <section id="sources" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/60 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="Sources" title="Bring knowledge from where it lives" text="Every source feeds the same knowledge base, so one chat can search all of it — or just the source you pick." />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {SOURCES.map((s) => (
                <article key={s.name} className="rounded-2xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}>
                    <s.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3 font-semibold text-slate-900">{s.name}</h3>
                  <p className="mt-1 text-sm text-slate-600">{s.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* AI models */}
        <section id="ai-models" className="scroll-mt-20 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="AI Models" title="Use the AI model that works for you." />
            <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
              {MODELS.map((m) => (
                <article key={m.name} className="rounded-2xl border border-slate-200 bg-white p-6 text-center transition-shadow hover:shadow-md">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white">
                    <Bot className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3 font-semibold text-slate-900">{m.name}</h3>
                  <p className="mt-1 text-sm text-slate-600">{m.text}</p>
                </article>
              ))}
            </div>
            <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-slate-500">
              Which models are available depends on the API keys and model settings your administrator configures. Keys stay on the server.
            </p>
          </div>
        </section>

        {/* Trust */}
        <section className="border-t border-slate-100 bg-slate-50/60 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="Trust" title="Answers you can check" />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST.map((t) => (
                <article key={t.title} className="rounded-2xl border border-slate-200 bg-white p-5">
                  <t.icon className="h-6 w-6 text-brand-600" />
                  <h3 className="mt-3 font-semibold text-slate-900">{t.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{t.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl rounded-3xl bg-navy-950 px-6 py-14 text-center shadow-xl sm:px-12">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Ready to explore your knowledge with AI?</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-300">Sign in with the demo account and try the real product: documents, website sources, chat and citations.</p>
            <Link href="/login" className="btn mt-8 bg-orange-500 px-6 py-3 text-base font-semibold text-navy-950 transition-transform hover:-translate-y-0.5 hover:bg-orange-400">
              Try the AI Demo <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div>
            <Logo />
            <p className="mt-2 text-sm text-slate-500">{BRAND.tagline}</p>
          </div>
          <nav aria-label="Footer" className="flex gap-6 text-sm text-slate-600">
            <a href="#top" className="hover:text-slate-900">Product</a>
            <a href="#features" className="hover:text-slate-900">Features</a>
            <Link href="/login" className="hover:text-slate-900">Login</Link>
          </nav>
        </div>
        <p className="border-t border-slate-100 py-4 text-center text-xs text-slate-400">
          © {year} {BRAND.name}. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
