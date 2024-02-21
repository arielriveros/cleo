import { useEffect, useState } from 'react';
import { Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import './TransformEditor.css';

export default function TransformEditor(props: {node: Node}) {

    const [position, setPosition] = useState(props.node.position);
    const [rotation, setRotation] = useState(props.node.rotation);
    const [scale, setScale] = useState(props.node.scale);

    useEffect(() => {
        setPosition(props.node.position);
        setRotation(props.node.rotation);
        setScale(props.node.scale);
    }, [props.node]);

    return (
        <Collapsable title='Transform'>
            <div className='transformContainer'>
            <div className='axisEditorContainer'>
                <div className='axisEditor'>
                    <div className='label'>Position</div>
                    <input type='number' className='numberInput x_axis' step={0.01} value={position[0]} onChange={(e) => {
                        props.node.setPosition([Number(e.target.value), position[1], position[2]]);
                        setPosition([Number(e.target.value), position[1], position[2]]);
                    }} />
                    <input type='number' className='numberInput y_axis' step={0.01} value={position[1]} onChange={(e) => {
                        props.node.setPosition([position[0], Number(e.target.value), position[2]]);
                        setPosition([position[0], Number(e.target.value), position[2]]);
                    }} />
                    <input type='number' className='numberInput z_axis' step={0.01} value={position[2]} onChange={(e) => {
                        props.node.setPosition([position[0], position[1], Number(e.target.value)]);
                        setPosition([position[0], position[1], Number(e.target.value)]);
                    }} />
                </div>
            </div>
            <div className='axisEditorContainer'>
                <div className='axisEditor'>
                    <div className='label'>Rotation</div>
                    <div className='rotation'>
                        <input type='range' className='rangeInput x_axis' min={-180} max={180} value={rotation[0]} onChange={(e) => {
                            props.node.setRotation([Number(e.target.value), rotation[1], rotation[2]]) 
                            setRotation([Number(e.target.value), rotation[1], rotation[2]]);
                        }} />
                        <input type='number' className='numberInput x_axis' style={{width: '50px'}} step={0.01} value={rotation[0]} onChange={(e) => {
                            props.node.setRotation([Number(e.target.value), rotation[1], rotation[2]]) 
                            setRotation([Number(e.target.value), rotation[1], rotation[2]]);
                        }} />
                    </div>
                    <div className='rotation'>
                        <input type='range' className='rangeInput y_axis' min={-180} max={180} value={rotation[1]} onChange={(e) => {
                            props.node.setRotation([rotation[0], Number(e.target.value), rotation[2]]) 
                            setRotation([rotation[0], Number(e.target.value), rotation[2]]);
                        }} />
                        <input type='number' className='numberInput y_axis' style={{width: '50px'}} step={0.01} value={rotation[1]} onChange={(e) => {
                            props.node.setRotation([rotation[0], Number(e.target.value), rotation[2]]) 
                            setRotation([rotation[0], Number(e.target.value), rotation[2]]);
                        }} />
                    </div>
                    <div className='rotation'>
                        <input type='range' className='rangeInput z_axis' min={-180} max={180} value={rotation[2]} onChange={(e) => {
                            props.node.setRotation([rotation[0], rotation[1], Number(e.target.value)]) 
                            setRotation([rotation[0], rotation[1], Number(e.target.value)]);
                        }} />
                        <input type='number' className='numberInput z_axis' style={{width: '50px'}} step={0.01} value={rotation[2]} onChange={(e) => {
                            props.node.setRotation([rotation[0], rotation[1], Number(e.target.value)]) 
                            setRotation([rotation[0], rotation[1], Number(e.target.value)]);
                        }} />
                    </div>
                </div>
            </div>
            <div className='axisEditorContainer'>
                <div className='axisEditor'>
                    <div className='label'>Scale</div>
                    <input type='number' className='numberInput x_axis' step={0.01} value={scale[0]} onChange={(e) => {
                        props.node.setScale([Number(e.target.value), scale[1], scale[2]]);
                        setScale([Number(e.target.value), scale[1], scale[2]]);
                    }} />
                    <input type='number' className='numberInput y_axis' step={0.01} value={scale[1]} onChange={(e) => {
                        props.node.setScale([scale[0], Number(e.target.value), scale[2]]);
                        setScale([scale[0], Number(e.target.value), scale[2]]);
                    }} />
                    <input type='number' className='numberInput z_axis' step={0.01} value={scale[2]} onChange={(e) => {
                        props.node.setScale([scale[0], scale[1], Number(e.target.value)]);
                        setScale([scale[0], scale[1], Number(e.target.value)]);
                    }} />
                </div>
            </div>
            </div>
        </Collapsable>
    )
}
