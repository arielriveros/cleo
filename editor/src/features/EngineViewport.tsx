import { useEffect, useRef } from "react";
import { useCleoEngine } from "./EngineContext";

export default function EngineViewport() {
    const { instance } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
    if (viewportRef.current && instance) {
        viewportRef.current.style.height = "100%";
        viewportRef.current.style.backgroundColor = "black";
        instance.setViewport(viewportRef.current);

        setTimeout(() => instance.renderer.resize(), 1);
    }
    }, [instance, viewportRef]);

    return <div ref={viewportRef} />;
}