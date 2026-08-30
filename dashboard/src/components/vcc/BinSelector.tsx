import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { fetchApi } from '@/lib/api';
import type { BinEntry } from '@/lib/bin-data';

interface BinSelectorProps {
  value: string;
  onChange: (bin: string) => void;
  onBinInfo?: (info: BinEntry | null) => void;
}

export function BinSelector({ value, onChange, onBinInfo }: BinSelectorProps) {
  const [brands, setBrands] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [bins, setBins] = useState<BinEntry[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');
  const [selectedBin, setSelectedBin] = useState<string>(value || '');
  const [loading, setLoading] = useState(false);
  const [binInfo, setBinInfo] = useState<BinEntry | null>(null);

  // Fetch brands on mount
  useEffect(() => {
    fetchBrands();
  }, []);

  // Fetch countries when brand changes
  useEffect(() => {
    if (selectedBrand) {
      fetchCountries(selectedBrand);
    } else {
      setCountries([]);
      setBins([]);
    }
  }, [selectedBrand]);

  // Fetch BINs when country changes
  useEffect(() => {
    if (selectedBrand && selectedCountry) {
      fetchBins(selectedBrand, selectedCountry);
    } else {
      setBins([]);
    }
  }, [selectedBrand, selectedCountry]);

  // Lookup BIN info when BIN changes
  useEffect(() => {
    if (selectedBin && selectedBin.length >= 6) {
      lookupBin(selectedBin);
    } else {
      setBinInfo(null);
      onBinInfo?.(null);
    }
  }, [selectedBin]);

  const fetchBrands = async () => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: string[] }>('/api/bin/brands');
      if (response.success) {
        setBrands(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch brands:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCountries = async (brand: string) => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: string[] }>(`/api/bin/countries/${brand}`);
      if (response.success) {
        setCountries(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch countries:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchBins = async (brand: string, country: string) => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: BinEntry[] }>(`/api/bin/list/${brand}/${country}`);
      if (response.success) {
        setBins(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch BINs:', error);
    } finally {
      setLoading(false);
    }
  };

  const lookupBin = async (bin: string) => {
    try {
      const response = await fetchApi<{ success: boolean; data: BinEntry }>(`/api/bin/lookup/${bin}`);
      if (response.success) {
        setBinInfo(response.data);
        onBinInfo?.(response.data);
      }
    } catch (error) {
      console.error('Failed to lookup BIN:', error);
      setBinInfo(null);
      onBinInfo?.(null);
    }
  };

  const handleBrandChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const brand = e.target.value;
    setSelectedBrand(brand);
    setSelectedCountry('');
    setSelectedBin('');
    setBins([]);
    onChange('');
  };

  const handleCountryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const country = e.target.value;
    setSelectedCountry(country);
    setSelectedBin('');
    onChange('');
  };

  const handleBinChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const bin = e.target.value;
    setSelectedBin(bin);
    onChange(bin);
  };

  return (
    <div className="space-y-3">
      {/* Brand Selection */}
      <div>
        <label htmlFor="brand" className="eyebrow mb-1.5 block">
          Card Brand
        </label>
        <Select
          id="brand"
          value={selectedBrand}
          onChange={handleBrandChange}
          disabled={loading}
        >
          <option value="">Select a brand</option>
          {brands.map((brand) => (
            <option key={brand} value={brand}>
              {brand.charAt(0).toUpperCase() + brand.slice(1)}
            </option>
          ))}
        </Select>
      </div>

      {/* Country Selection */}
      <div>
        <label htmlFor="country" className="eyebrow mb-1.5 block">
          Country
        </label>
        <Select
          id="country"
          value={selectedCountry}
          onChange={handleCountryChange}
          disabled={!selectedBrand || loading}
        >
          <option value="">Select a country</option>
          {countries.map((country) => (
            <option key={country} value={country}>
              {country}
            </option>
          ))}
        </Select>
      </div>

      {/* BIN Selection */}
      <div>
        <label htmlFor="bin" className="eyebrow mb-1.5 block">
          BIN
        </label>
        <Select
          id="bin"
          value={selectedBin}
          onChange={handleBinChange}
          disabled={!selectedCountry || loading}
          className="font-mono"
        >
          <option value="">Select a BIN</option>
          {bins.map((binEntry) => (
            <option key={binEntry.bin} value={binEntry.bin}>
              {binEntry.bin} - {binEntry.issuer}
            </option>
          ))}
        </Select>
      </div>

      {/* Custom BIN Input */}
      <div>
        <label htmlFor="custom-bin" className="eyebrow mb-1.5 block">
          Or enter custom BIN (6 digits)
        </label>
        <Input
          id="custom-bin"
          type="text"
          placeholder="Enter 6-digit BIN"
          maxLength={6}
          className="font-mono"
          value={selectedBin}
          onChange={(e) => {
            const bin = e.target.value.replace(/\D/g, '');
            setSelectedBin(bin);
            onChange(bin);
          }}
        />
      </div>

      {/* BIN Info Display */}
      {binInfo && (
        <div className="space-y-2 border-l-2 border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{binInfo.brand.toUpperCase()}</Badge>
            {binInfo.type && <Badge variant="outline">{binInfo.type}</Badge>}
          </div>
          <div className="space-y-1 font-mono text-[11px] text-[var(--muted-foreground)]">
            <div>
              <span className="text-[var(--muted-foreground)]">BIN:</span>{' '}
              <span className="text-[var(--foreground)]">{binInfo.bin}</span>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">Issuer:</span>{' '}
              <span className="text-[var(--foreground)]">{binInfo.issuer}</span>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">Country:</span>{' '}
              <span className="text-[var(--foreground)]">{binInfo.countryName}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
