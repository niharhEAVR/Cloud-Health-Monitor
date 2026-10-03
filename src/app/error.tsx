"use client";

import { AppHeader } from "@/components/monitor-ui";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) { return <><AppHeader /><main className="page" id="main-content"><section className="panel empty-state" role="alert"><h1>Something went wrong</h1><p>We could not show this page. Your saved monitoring data was not changed.</p><button className="button primary" type="button" onClick={reset}>Try again</button></section></main></>; }
