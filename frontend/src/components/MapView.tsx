import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Circle, useMap, Popup } from "react-leaflet";
import L from "leaflet";

// Fix default Leaflet marker icons (otherwise they 404 in bundlers).
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";

L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

export type MapMarker = {
  id: string | number;
  lat: number;
  lng: number;
  label?: string;
  color?: string;
  radius_m?: number;
  solved?: boolean;
  showRadius?: boolean;
};

function makeDot(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width: 18px; height: 18px; border-radius: 50%;
      background:${color}; border:2px solid white;
      box-shadow:0 0 0 2px rgba(0,0,0,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function FitBounds({ markers, fallback }: { markers: MapMarker[]; fallback: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    if (markers.length === 0) {
      map.setView(fallback, 14);
      return;
    }
    if (markers.length === 1) {
      map.setView([markers[0].lat, markers[0].lng], 16);
      return;
    }
    const bounds = L.latLngBounds(markers.map(m => [m.lat, m.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [markers, map, fallback]);
  return null;
}

type Props = {
  markers: MapMarker[];
  user?: { lat: number; lng: number } | null;
  fallbackCenter?: [number, number];
  className?: string;
  onMapClick?: (lat: number, lng: number) => void;
  big?: boolean;
};

function ClickHandler({ onMapClick }: { onMapClick?: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    if (!onMapClick) return;
    const handler = (e: L.LeafletMouseEvent) => onMapClick(e.latlng.lat, e.latlng.lng);
    map.on("click", handler);
    return () => { map.off("click", handler); };
  }, [map, onMapClick]);
  return null;
}

export default function MapView({
  markers,
  user,
  fallbackCenter = [52.0907, 5.1214], // Utrecht
  className,
  onMapClick,
  big,
}: Props) {
  const center = markers[0] ? [markers[0].lat, markers[0].lng] as [number, number] : fallbackCenter;
  return (
    <div className={`map-wrap ${big ? "map-wrap--big" : ""} ${className ?? ""}`}>
      <MapContainer center={center} zoom={14} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds markers={user ? [...markers, { id: "_user", lat: user.lat, lng: user.lng }] : markers} fallback={fallbackCenter} />
        <ClickHandler onMapClick={onMapClick} />
        {markers.map(m => (
          <Marker key={m.id} position={[m.lat, m.lng]} icon={makeDot(m.color ?? (m.solved ? "#2bb673" : "#d04a02"))}>
            {m.label && <Popup>{m.label}</Popup>}
          </Marker>
        ))}
        {markers.filter(m => m.showRadius && m.radius_m).map(m => (
          <Circle
            key={`r-${m.id}`}
            center={[m.lat, m.lng]}
            radius={m.radius_m!}
            pathOptions={{ color: m.solved ? "#2bb673" : "#d04a02", fillOpacity: 0.1, weight: 1 }}
          />
        ))}
        {user && (
          <Marker position={[user.lat, user.lng]} icon={makeDot("#5ab9ff")}>
            <Popup>You</Popup>
          </Marker>
        )}
      </MapContainer>
    </div>
  );
}
