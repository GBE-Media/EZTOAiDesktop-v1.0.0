import { useState, useEffect } from 'react';
import { useCanvasStore } from '@/store/canvasStore';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Ruler, Target, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

const units = [
  { value: 'ft', label: 'Feet (ft)' },
  { value: 'in', label: 'Inches (in)' },
  { value: 'm', label: 'Meters (m)' },
  { value: 'cm', label: 'Centimeters (cm)' },
  { value: 'mm', label: 'Millimeters (mm)' },
];

export function CalibrationDialog() {
  const { calibration, completeCalibration, cancelCalibration } = useCanvasStore();
  const [distance, setDistance] = useState('');
  const [unit, setUnit] = useState('ft');

  const pixelDistance = calibration.point1 && calibration.point2
    ? Math.sqrt(
        Math.pow(calibration.point2.x - calibration.point1.x, 2) +
        Math.pow(calibration.point2.y - calibration.point1.y, 2)
      )
    : 0;

  const isOpen = calibration.isCalibrating && calibration.point1 !== null && calibration.point2 !== null;

  const handleComplete = () => {
    const distanceValue = parseFloat(distance);
    if (isNaN(distanceValue) || distanceValue <= 0) {
      toast.error('Please enter a valid distance');
      return;
    }
    
    completeCalibration(distanceValue, unit);
    toast.success(`Scale set: ${pixelDistance.toFixed(1)}px = ${distanceValue} ${unit}`);
    setDistance('');
  };

  const handleCancel = () => {
    cancelCalibration();
    setDistance('');
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) handleCancel();
    }}>
      <DialogContent className="sm:max-w-md bg-panel border-panel-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Ruler className="w-4 h-4 text-primary" />
            Scale Calibration
          </DialogTitle>
          <DialogDescription className="text-xs">
            Enter the real-world distance for the line you drew.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center gap-2 text-sm text-green-500">
            <CheckCircle2 className="w-4 h-4" />
            <span>Distance measured: {pixelDistance.toFixed(1)} pixels</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="distance" className="text-xs">Actual Distance</Label>
            <div className="flex gap-2">
              <Input
                id="distance"
                type="number"
                step="0.01"
                min="0"
                placeholder="Enter distance"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                className="flex-1 h-8 text-sm bg-secondary border-panel-border"
                autoFocus
              />
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger className="w-28 h-8 text-sm bg-secondary border-panel-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-panel-border">
                  {units.map((u) => (
                    <SelectItem key={u.value} value={u.value} className="text-xs">
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {distance && !isNaN(parseFloat(distance)) && parseFloat(distance) > 0 && (
            <div className="bg-secondary/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Scale Preview</p>
              <p className="font-mono text-sm text-primary">
                1 {unit} = {(pixelDistance / parseFloat(distance)).toFixed(2)} pixels
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel} className="text-xs">
            Cancel
          </Button>
          <Button 
            size="sm"
            onClick={handleComplete}
            disabled={!distance || parseFloat(distance) <= 0}
            className="text-xs"
          >
            Apply Scale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
