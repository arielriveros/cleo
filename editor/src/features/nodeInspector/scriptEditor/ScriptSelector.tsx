import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable';

export default function ScriptSelector() {

    const { selectedScript, setSelectedScript } = useCleoEngine();

    const onScriptSelected = (script: string) => {
        setSelectedScript(script);
    };

    return (
        <Collapsable title='Scripts'>
            <button onClick={() => onScriptSelected('OnSpawn')} disabled={selectedScript === 'OnSpawn'}>OnSpawn</button>
            <button onClick={() => onScriptSelected('OnStart')} disabled={selectedScript === 'OnStart'}>OnStart</button>
            <button onClick={() => onScriptSelected('OnUpdate')} disabled={selectedScript === 'OnUpdate'}>OnUpdate</button>
            <button onClick={() => onScriptSelected('OnCollision')} disabled={selectedScript === 'OnCollision'}>OnCollision</button>
        </Collapsable>
    )
}
