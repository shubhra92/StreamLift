import { NextRequest, NextResponse } from "next/server";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";

const API_HOST = process.env.SERVER_HOST

const NO_BODY_METHOD = new Set([ "DELETE", "GET" ]);
const NOT_ALLOWED_REQ_HEADERS = new Set([ "host", "origin", "referer" ]);
const NOT_ALLOWED_RES_HEADERS = new Set([ "x-powered-by", "content-encoding", "transfer-encoding", "content-length" ]);

// Check if this is an SSE request
function isSSERequest(pathname: string, accept: string | null): boolean {
    return pathname.endsWith('/stream') || accept?.includes('text/event-stream') || false;
}

//All Request Handler
async function handler(req: NextRequest) {
    // Validate guest session before forwarding anything to Express.
    // This prevents unauthenticated requests from reaching the backend.
    const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
    if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const guest = await validateGuestToken(token);
    if (!guest) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = `${API_HOST}${req.nextUrl.pathname}${req.nextUrl.search}`
        const isSSE = isSSERequest(req.nextUrl.pathname, req.headers.get('accept'));

        // Replicate Headers
        const clientHeaders: Record<string, string> = {};
        req.headers.forEach((value, key) => {
            if (!NOT_ALLOWED_REQ_HEADERS.has(key.toLowerCase())) {
                clientHeaders[key] = value;
            }
        });

        // For SSE, ensure proper accept header
        if (isSSE) {
            clientHeaders['accept'] = 'text/event-stream';
        }

        const requestInit: RequestInit = {
            method: req.method,
            headers: clientHeaders,
            // Disable caching for SSE
            cache: isSSE ? 'no-store' : 'default',
        }

        // Handle Body & Duplex
        if(!NO_BODY_METHOD.has(req.method.toUpperCase())){
            requestInit.body = req.body
            // @ts-ignore - 'duplex' is required when sending a stream in a fetch request
            requestInit.duplex = 'half'
        }

        const res = await fetch(url, requestInit)

        // Construct Response Headers
        const responseHeaders = new Headers();
        res.headers.forEach((value, key) => {
            if (!NOT_ALLOWED_RES_HEADERS.has(key.toLowerCase())) {
                responseHeaders.set(key, value);
            }
        });

        // Handle SSE responses - stream without buffering
        if (isSSE && res.ok && res.body) {
            responseHeaders.set('Content-Type', 'text/event-stream');
            responseHeaders.set('Cache-Control', 'no-cache, no-transform');
            responseHeaders.set('Connection', 'keep-alive');
            responseHeaders.set('X-Accel-Buffering', 'no'); // Disable nginx buffering
            
            return new Response(res.body, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // Handle Backend Errors (!res.ok)
        // If the backend returns 404, 401, 500 etc., we still want to 
        // forward that specific error body to the frontend.
        if (!res.ok) {
            const errorData = await res.text();
            return new Response(errorData, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // For non-SSE responses, read the full body to avoid truncation
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json') || contentType.includes('text/')) {
            const body = await res.text();
            return new Response(body, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // For binary/other content, stream the body back
        return new Response(res.body, {
            headers: responseHeaders
        });
    } catch (error: any) {
        // Handle Critical Bridge Failures (e.g., Express is down)
        console.error("Bridge Connection Error:", error.message);
        
        return NextResponse.json(
            { 
              error: "Gateway Error", 
              details: error.message,
              target: API_HOST 
            }, 
            { status: 502 } // Bad Gateway
        )
    }
}

// Force dynamic rendering for SSE routes
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };