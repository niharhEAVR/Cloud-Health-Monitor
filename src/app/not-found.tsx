import Link from "next/link";
import { AppHeader } from "@/components/monitor-ui";

export default function NotFound() { return <><AppHeader /><main className="page" id="main-content"><section className="panel empty-state"><h1>Service not found</h1><p>It may have been deleted or the address is incorrect.</p><Link className="button primary" href="/">Back to dashboard</Link></section></main></>; }
