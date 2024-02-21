import { useState, useEffect } from 'react'
import { LightNode, ModelNode, Vec } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import './MaterialEditor.css'

export default function LightEditor(props: {node: LightNode}) {

    const colorToVec3 = (color: string) => {
        return color.match(/[A-Za-z0-9]{2}/g)!.map(function(v) { return parseInt(v, 16) / 255});
    };

    const compToHex = (c: number) => {
        var hex = c.toString(16);
        return hex.length == 1 ? "0" + hex : hex;
    };

    const vec3ToHex = (vec: Vec.vec3) => {
        return "#" + compToHex(Math.round(vec[0] * 255)) + compToHex(Math.round(vec[1] * 255)) + compToHex(Math.round(vec[2] * 255));
    };

    const light = props.node.light;

    const [diffuse, setDiffuse] = useState(vec3ToHex(light.diffuse));
    const [specular, setSpecular] = useState(vec3ToHex(light.specular));
    const [ambient, setAmbient] = useState(vec3ToHex(light.ambient));

    useEffect(() => {
        setDiffuse(vec3ToHex(light.diffuse));
        setSpecular(vec3ToHex(light.specular));
        setAmbient(vec3ToHex(light.ambient));
    }, [props.node])

    useEffect(() => {
        const debugModel = props.node.getChildByName('__debug__LightModel');
        if (debugModel[0])
            (debugModel[0] as ModelNode).model.material.properties.set('color', light.diffuse);
    }, [props.node, diffuse])

    return (
        <Collapsable title='Light'>
        <div className='materialEditor'>
        <h4>Colors</h4>
            <table>
                <tbody>
                    <tr>
                        <td>Diffuse</td>
                        <td>Specular</td>
                        <td>Ambient</td>
                    </tr>
                    <tr>
                        <td>
                            <input type='color' className='materialInput' value={diffuse} onChange={(e) => {
                                let color = colorToVec3(e.target.value);
                                light.diffuse[0] = color[0];
                                light.diffuse[1] = color[1];
                                light.diffuse[2] = color[2];
                                setDiffuse(e.target.value);

                                // change

                            }} 
                            />
                        </td>
                        
                        <td>
                            <input type='color' className='materialInput' value={specular} onChange={(e) => {
                                let color = colorToVec3(e.target.value);
                                light.specular[0] = color[0];
                                light.specular[1] = color[1];
                                light.specular[2] = color[2];
                                setSpecular(e.target.value); }}
                            />
                        </td>
                        <td>
                            <input type='color' className='materialInput' value={ambient} onChange={(e) => {
                                let color = colorToVec3(e.target.value);
                                light.ambient[0] = color[0];
                                light.ambient[1] = color[1];
                                light.ambient[2] = color[2];
                                setAmbient(e.target.value); }}
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        </Collapsable>
    )
}
