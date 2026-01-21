import { useState } from 'react';
import { Upload, ExternalLink, Plug, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useProductStore } from '@/store/productStore';
import { supabase } from '@/integrations/supabase/client';
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
  status: 'idle' | 'success' | 'error';
  message: string;
  endpoint?: string;
}

export function ExportProductsDialog({ open, onOpenChange }: ExportProductsDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);

  const { exportProducts, nodes } = useProductStore();

  const productCount = Object.values(nodes).filter(n => n.type === 'product').length;
  const measurementCount = Object.values(nodes)
    .filter(n => n.type === 'product')
    .reduce((sum, n) => sum + (n.measurements?.length || 0), 0);

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const { data, error } = await supabase.functions.invoke('test-export-connection');

      if (error) {
        setConnectionStatus({
          status: 'error',
          message: error.message || 'Connection test failed',
        });
        toast.error('API connection test failed');
        return;
      }

      if (!data?.configured || data?.status === 'error') {
        setConnectionStatus({
          status: 'error',
          message: data?.message || 'API is not configured',
          endpoint: data?.endpoint,
        });
        toast.error(data?.message || 'API connection failed');
      } else {
        setConnectionStatus({
          status: 'success',
          message: data.message || 'Connected successfully',
          endpoint: data.endpoint,
        });
        toast.success('API connection successful!');
      }
    } catch (err) {
      setConnectionStatus({
        status: 'error',
        message: 'Connection test failed unexpectedly',
      });
      toast.error('Connection test failed');
    } finally {
      setIsTesting(false);
    }
  };

  const handleExport = async () => {
    if (!projectName.trim()) {
      toast.error('Please enter a project name');
      return;
    }

    setIsExporting(true);

    try {
      const payload = exportProducts(projectName.trim());
      
      // Call the edge function to handle the export
      const { data, error } = await supabase.functions.invoke('export-products', {
        body: payload,
      });

      if (error) {
        throw new Error(error.message || 'Export failed');
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      toast.success(data?.message || 'Products exported successfully!');
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

  const getStatusIcon = () => {
    if (isTesting) {
      return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />;
    }
    if (!connectionStatus) {
      return <Plug className="w-4 h-4 text-muted-foreground" />;
    }
    if (connectionStatus.status === 'success') {
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    }
    return <XCircle className="w-4 h-4 text-destructive" />;
  };

  const getStatusText = () => {
    if (isTesting) return 'Testing connection...';
    if (!connectionStatus) return 'Status unknown';
    return connectionStatus.message;
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

          {/* API Connection Status */}
          <div className="space-y-2">
            <Label>API Connection</Label>
            <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {getStatusIcon()}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{getStatusText()}</p>
                  {connectionStatus?.endpoint && (
                    <p className="text-xs text-muted-foreground truncate">
                      {connectionStatus.endpoint}
                    </p>
                  )}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="ml-2 shrink-0"
              >
                {isTesting ? 'Testing...' : connectionStatus ? 'Test Again' : 'Test Connection'}
              </Button>
            </div>
          </div>

          {/* Info about API configuration */}
          <p className="text-xs text-muted-foreground">
            Configure the API endpoint and key in your backend secrets.
          </p>
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
            disabled={isExporting || productCount === 0}
          >
            {isExporting ? (
              <>Exporting...</>
            ) : (
              <>
                <ExternalLink className="w-4 h-4 mr-2" />
                Export to API
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
