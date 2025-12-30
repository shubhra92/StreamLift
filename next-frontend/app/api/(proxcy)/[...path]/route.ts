import { NextRequest, NextResponse } from "next/server";

const API_HOST = process.env.SERVER_HOST

const NO_BODY_METHOD = new Set([ "DELETE", "GET" ]);
const NOT_ALLOWED_REQ_HEADERS = new Set([ "host", "origin", "referer" ]);
const NOT_ALLOWED_RES_HEADERS = new Set([ "x-powered-by" ]);

//All Request Handler
async function handler(req: NextRequest) {
    try {
        const url = `${API_HOST}${req.nextUrl.pathname}${req.nextUrl.search}`

        // Replicate Headers
        const clientHeaders: Record<string, string> = {};
        req.headers.forEach((value, key) => {
            if (!NOT_ALLOWED_REQ_HEADERS.has(key.toLowerCase())) {
                clientHeaders[key] = value;
            }
        });

        const requestInit: RequestInit = {
            method: req.method,
            headers: clientHeaders,
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

        // Handle Backend Errors (!res.ok)
        // If the backend returns 404, 401, 500 etc., we still want to 
        // forward that specific error body to the frontend.
        if (!res.ok) {
            const errorData = await res.text(); // or res.json()
            return new Response(errorData, {
                status: res.status,
                headers: responseHeaders, // Keeps content-type from backend
            });
        }

        // Success: Stream the body back
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

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };