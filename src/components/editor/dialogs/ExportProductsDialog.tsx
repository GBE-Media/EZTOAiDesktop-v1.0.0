import { useState } from 'react';
import { Upload, ExternalLink, CheckCircle2, XCircle, Loader2, Plug } from 'lucide-react';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { externalAuthClient } from '@/integrations/external-auth/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ExportProductsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ConnectionStatus {
  status: 'idle' | 'testing' | 'success' | 'error';
  message: string;
}

// Import endpoint - uses Supabase Edge Function
const SUPABASE_URL = import.meta.env.VITE_EXTERNAL_SUPABASE_URL || 'https://einpdmanlpadqyqnvccb.supabase.co';
const IMPORT_ENDPOINT = `${SUPABASE_URL}/functions/v1/receive-products`;

export function ExportProductsDialog({ open, onOpenChange }: ExportProductsDialogProps) {
  const { user, session } = useAuth();
  const [projectName, setProjectName] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    status: 'idle',
    message: 'Not tested',
  });

  const { exportProducts, nodes } = useProductStore();
  const { activeDocument } = useEditorStore();

  // Count only products that have measurements for the ACTIVE document
  // This matches the behavior of the Products tab
  const productsWithMeasurements = Object.values(nodes).filter(n => {
    if (n.type !== 'product') return false;
    const docMeasurements = (n.measurements || []).filter(
      m => m.documentId === activeDocument
    );
    return docMeasurements.length > 0;
  });
  const productCount = productsWithMeasurements.length;
  const measurementCount = productsWithMeasurements.reduce((sum, n) => {
    const docMeasurements = (n.measurements || []).filter(
      m => m.documentId === activeDocument
    );
    return sum + docMeasurements.length;
  }, 0);

  const handleTestConnection = async () => {
    if (!session?.access_token) {
      toast.error('You must be logged in to test the connection');
      return;
    }

    setConnectionStatus({ status: 'testing', message: 'Testing connection...' });

    try {
      // Get fresh session token
      const { data: { session: currentSession } } = await externalAuthClient.auth.getSession();
      
      if (!currentSession?.access_token) {
        throw new Error('Session expired. Please log in again.');
      }

      // Send a test request to the endpoint
      // We'll use a GET request or OPTIONS to test connectivity
      const response = await fetch(IMPORT_ENDPOINT, {
        method: 'OPTIONS',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession.access_token}`,
        },
      });

      // Any response (even 4xx for OPTIONS) means the endpoint is reachable
      setConnectionStatus({
        status: 'success',
        message: 'Connection successful',
      });
      toast.success('API connection successful!');
    } catch (err) {
      // Try a HEAD request as fallback
      try {
        const { data: { session: currentSession } } = await externalAuthClient.auth.getSession();
        
        const response = await fetch(IMPORT_ENDPOINT, {
          method: 'HEAD',
          headers: {
            'Authorization': `Bearer ${currentSession?.access_token}`,
          },
        });

        setConnectionStatus({
          status: 'success',
          message: 'Connection successful',
        });
        toast.success('API connection successful!');
      } catch (headErr) {
        setConnectionStatus({
          status: 'error',
          message: 'Could not reach the API endpoint',
        });
        toast.error('Could not reach the API endpoint. Please check your network connection.');
      }
    }
  };

  const handleExport = async () => {
    if (!projectName.trim()) {
      toast.error('Please enter a project name');
      return;
    }

    if (!session?.access_token) {
      toast.error('You must be logged in to export');
      return;
    }

    setIsExporting(true);

    try {
      const payload = exportProducts(projectName.trim());
      
      // Get fresh session token
      const { data: { session: currentSession } } = await externalAuthClient.auth.getSession();
      
      if (!currentSession?.access_token) {
        throw new Error('Session expired. Please log in again.');
      }

      // Call the API with session token authentication
      const response = await fetch(IMPORT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Export failed with status ${response.status}`);
      }

      const data = await response.json();
      
      toast.success(data?.message || `Successfully exported ${productCount} products!`);
      onOpenChange(false);
    } catch (error) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadJson = () => {
    if (!projectName.trim()) {
      toast.error('Please enter a project name');
      return;
    }

    const payload = exportProducts(projectName.trim());
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.trim().replace(/\s+/g, '-').toLowerCase()}-products.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast.success('Products exported to JSON file');
  };

  const isAuthenticated = !!session?.access_token;
  const isTesting = connectionStatus.status === 'testing';

  const getConnectionIcon = () => {
    switch (connectionStatus.status) {
      case 'testing':
        return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />;
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-destructive" />;
      default:
        return <Plug className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Export Products to Estimate
          </DialogTitle>
          <DialogDescription>
            Export your products and measurements to your estimate project
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Summary */}
          <div className="flex gap-4 p-3 bg-secondary rounded-lg text-sm">
            <div>
              <span className="text-muted-foreground">Products:</span>{' '}
              <span className="font-medium">{productCount}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Measurements:</span>{' '}
              <span className="font-medium">{measurementCount}</span>
            </div>
          </div>

          {/* Project Name */}
          <div className="space-y-2">
            <Label htmlFor="project-name">Project Name</Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g., Office Building Renovation"
            />
          </div>

          {/* Authentication Status */}
          <div className="flex items-center gap-2 p-3 bg-secondary rounded-lg">
            {isAuthenticated ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">Signed in</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.email}
                  </p>
                </div>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 text-destructive" />
                <p className="text-sm">Please sign in to export</p>
              </>
            )}
          </div>

          {/* API Connection Status */}
          <div className="space-y-2">
            <Label>API Connection</Label>
            <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {getConnectionIcon()}
                <p className="text-sm">{connectionStatus.message}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={isTesting || !isAuthenticated}
                className="ml-2 shrink-0"
              >
                {isTesting ? 'Testing...' : connectionStatus.status === 'success' ? 'Test Again' : 'Test Connection'}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleDownloadJson}
            disabled={productCount === 0}
          >
            Download JSON
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={isExporting || productCount === 0 || !isAuthenticated}
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <ExternalLink className="w-4 h-4 mr-2" />
                Export to Estimate
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
