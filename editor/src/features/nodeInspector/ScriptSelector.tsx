import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable';

export default function ScriptSelector() {

    const { setMode, selectedScript, setSelectedScript } = useCleoEngine();

    const onScriptSelected = (script: string) => {
        setSelectedScript(script);
        setMode('script');
    };

    return (
        <Collapsable title='Scripts'>
            <button onClick={() => onScriptSelected('OnSpawn')} disabled={selectedScript === 'OnSpawn'}>OnSpawn</button>
            <button onClick={() => onScriptSelected('OnStart')} disabled={selectedScript === 'OnStart'}>OnStart</button>
            <button onClick={() => onScriptSelected('OnUpdate')} disabled={selectedScript === 'OnUpdate'}>OnUpdate</button>
        </Collapsable>
    )
}