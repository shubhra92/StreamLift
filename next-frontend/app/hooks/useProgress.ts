import { useState, useEffect, useCallback, useRef } from 'react';

interface Progress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

export function useProgress(id: string | null, pollInterval = 10000) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'sse' | 'polling'>('idle');
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Polling fetch
  const fetchProgress = useCallback(async () => {
    if (!id) return;
    
    try {
      const res = await fetch(`/api/progress/${id}`);
      
      if (!res.ok) {
        if (res.status === 404) {
          setError('Download not found');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      
      const data: Progress = await res.json();
      setProgress(data);
      setError(null);
      
      if (data.done) {
        cleanup();
        setMode('idle');
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, cleanup]);

  // Start polling fallback
  const startPolling = useCallback(() => {
    if (!id || pollingRef.current) return;
    
    console.log('Falling back to polling mode');
    setMode('polling');
    
    fetchProgress();
    pollingRef.current = setInterval(fetchProgress, pollInterval);
  }, [id, pollInterval, fetchProgress]);

  // Start SSE connection
  const startSSE = useCallback(() => {
    if (!id) return;
    
    cleanup();
    setMode('sse');
    setProgress(null);
    setError(null);
    
    console.log('Starting SSE connection');
    const es = new EventSource(`/api/progress/${id}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: Progress = JSON.parse(event.data);
        setProgress(data);
        setError(null);

        if (data.done) {
          cleanup();
          setMode('idle');
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.onerror = () => {
      console.log('SSE connection failed, switching to polling');
      cleanup();
      startPolling();
    };
  }, [id, cleanup, startPolling]);

  // Auto-start when id changes
  useEffect(() => {
    if (id) {
      startSSE();
    } else {
      cleanup();
      setMode('idle');
      setProgress(null);
      setError(null);
    }

    return cleanup;
  }, [id, startSSE, cleanup]);

  return {
    progress,
    error,
    mode,
    isDone: progress?.done ?? false,
  };
}
