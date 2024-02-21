import { useState, useEffect } from 'react'
import { ModelNode, Vec, TextureManager, Texture, Model, Material } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import './MaterialEditor.css'

function TextureInspector(props: { tex: string, material: Material }) {
    const [texture, setTexture] = useState<Texture | null>(null);
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    useEffect(() => {
        const texId = props.material.textures.get(props.tex);
        setTexture(texId ? TextureManager.Instance.getTexture(texId) : null);
    }, [props.material, props.tex])

    useEffect(() => {
        setImg(texture ? (texture.data as HTMLImageElement | null) : null);
    }, [texture])

    const deleteTexture = () => {
        TextureManager.Instance.removeTexture(props.material.textures.get(props.tex)!);
        props.material.textures.delete(props.tex);
        if (props.tex === 'baseTexture')
            props.material.properties.set('hasBaseTexture', false)
        else
            props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, false)

        setTexture(null);
        setImg(null);
    }

    const onTextureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.item(0);
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const data = e.target?.result;
                const img = new Image();
                img.src = data as string;
                img.onload = () => {
                    setImg(img);
                    if (texture) texture.updateImg(img);
                    else {
                        const tex = TextureManager.Instance.addTextureFromData(img);
                        props.material.textures.set(props.tex, tex);
                        if (props.tex === 'baseTexture')
                            props.material.properties.set('hasBaseTexture', true)
                        else {
                            props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, true)
                        }
                    }
                }
            }
            reader.readAsDataURL(file);
        }
    }

    return (
        <div className='textureInspector'>
            {img && <img className='texImage' src={img.src} />}
            <button className='textureDelete' onClick={() => deleteTexture()}> ✕ </button>
            <label htmlFor={`${props.tex}-upload`} className="textureFileUpload">
                Upload
            </label>
            <input id={`${props.tex}-upload`} type='file' onChange={ e => onTextureUpload(e)} />
        </div>
    )
}

export default function MaterialEditor(props: {node: ModelNode}) {

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

    const model = props.node.model;
    const material = model.material;

    const [diffuse, setDiffuse] = useState(vec3ToHex(material.properties.get('diffuse')));
    const [specular, setSpecular] = useState(vec3ToHex(material.properties.get('specular')));
    const [ambient, setAmbient] = useState(vec3ToHex(material.properties.get('ambient')));
    const [shininess, setShininess] = useState(material.properties.get('shininess'));
    const [emission, setEmission] = useState(vec3ToHex(material.properties.get('emissive')));

    useEffect(() => {
        setDiffuse(vec3ToHex(material.properties.get('diffuse')));
        setSpecular(vec3ToHex(material.properties.get('specular')));
        setAmbient(vec3ToHex(material.properties.get('ambient')));
        setShininess(material.properties.get('shininess'));
        setEmission(vec3ToHex(material.properties.get('emissive')));

    }, [props.node])

    return (
        <Collapsable title='Material'>
        <div className='materialEditor'>
        <h5>Colors</h5>
            <table>
                <tbody>
                    <tr>
                        <td>Diffuse</td>
                        <td>Specular</td>
                        <td>Shininess</td>
                        <td>Ambient</td>
                        <td>Emission</td>
                    </tr>
                    <tr>
                        <td>
                            <input type='color' className='materialInput' value={diffuse} onChange={(e) => {
                                model.material.properties.set('diffuse', colorToVec3(e.target.value));
                                setDiffuse(e.target.value); }} 
                            />
                        </td>
                        
                        <td>
                            <input type='color' className='materialInput' value={specular} onChange={(e) => {
                                model.material.properties.set('specular', colorToVec3(e.target.value));
                                setSpecular(e.target.value); }}
                            />
                        </td>
                        <td>
                            <input type='number' className='materialInput' value={shininess} onChange={(e) => {
                                model.material.properties.set('shininess', Number(e.target.value));
                                setShininess(e.target.value); }}
                            />
                        </td>
                        <td>
                            <input type='color' className='materialInput' value={ambient} onChange={(e) => {
                                model.material.properties.set('ambient', colorToVec3(e.target.value));
                                setAmbient(e.target.value); }}
                            />
                        </td>
                        <td>
                            <input type='color' className='materialInput' value={emission} onChange={(e) => {
                                model.material.properties.set('emissive', colorToVec3(e.target.value));
                                setEmission(e.target.value); }}
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
        <h5>Textures</h5>
        <table>
            <tbody>
                <tr>
                    <td>Diffuse</td>
                    <td>Specular</td>
                    <td>Normal</td>
                </tr>
                <tr>
                    <td>
                        <TextureInspector tex={'baseTexture'} material={model.material} />
                    </td>
                    <td>
                        <TextureInspector tex={'specularMap'} material={model.material} />
                    </td>
                    <td>
                        <TextureInspector tex={'normalMap'} material={model.material} />
                    </td>
                </tr>
                <tr>
                    <td>Emission</td>
                    <td>Mask</td>
                    <td>Reflectivity</td>
                </tr>
                <tr>
                    <td>
                        <TextureInspector tex={'emissiveMap'} material={model.material} />
                    </td>
                    <td>
                        <TextureInspector tex={'maskMap'} material={model.material} />
                    </td>
                    <td>
                        <TextureInspector tex={'reflectivityMap'} material={model.material} />
                    </td>
                </tr>
            </tbody>
        </table>
        <h5>Options</h5>
        <table>
            <tbody>
                <tr>
                    <td>Wireframe</td>
                    <td>Transparent</td>
                    <td>Side</td>
                    <td>Cast Shadow</td>
                </tr>
                <tr>
                    <td>
                        <input type='checkbox' checked={model.material.config.wireframe} onChange={(e) => {
                            model.material.config.wireframe = !model.material.config.wireframe;
                        }} />
                    </td>
                    <td>
                        <input type='checkbox' checked={model.material.config.transparent} onChange={(e) => {
                            model.material.config.transparent = !model.material.config.transparent;
                        }} />
                    </td>
                    <td>
                        <select value={model.material.config.side} onChange={(e) => {
                            model.material.config.side = e.target.value as 'front' | 'back' | 'double';
                            }}> 
                            <option value={'front'}>Front</option>
                            <option value={'back'}>Back</option>
                            <option value={'double'}>Both</option>
                        </select>
                    </td>
                    <td>
                        <input type='checkbox' checked={model.material.config.castShadow} onChange={(e) => {
                            model.material.config.castShadow = !model.material.config.castShadow;
                        }} />
                    </td>
                </tr>
            </tbody>
        </table>
        </div>
        </Collapsable>
    )
}
