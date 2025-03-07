// externals
import * as graphql from 'graphql'
import { Config, parentTypeFromAncestors } from '../../common'
import { ArtifactKind } from '../../runtime/types'
// locals
import { CollectedGraphQLDocument, RefetchUpdateMode } from '../types'
import { unwrapType, wrapType } from '../utils'

// the paginate transform is responsible for preparing a fragment marked for pagination
// to be embedded in the query that will be used to fetch additional data. That means it
// is responsible for adding additional arguments to the paginated field and hoisting
// all of the pagination args to arguments of the fragment itself. It then generates
// a query that threads query variables to the updated fragment and lets the fragment
// argument transform do the rest. This whole process happens in a few steps:

// - walk through the document and look for a field marked for pagination. if one is found,
//   add the necessary arguments to the field, referencing variables that will be injected
//   and compute what kind of pagination (toggling an object of flags)
// - if the @paginate directive was found, add the @arguments directive to the fragment
//   definition to pass new pagination arguments and use any fields that were previously
//   set as the default value. That will cause the fragment arguments directive to inline
//   the default values if one isn't given, preserving the original definition for the first query
// - generate the query with the fragment embedded using @with to pass query variables through

type PaginationFlags = {
	[fieldName: string]: { enabled: boolean; type: 'String' | 'Int'; defaultValue?: any }
}

// paginate transform adds the necessary fields for a paginated field
export default async function paginate(
	config: Config,
	documents: CollectedGraphQLDocument[]
): Promise<void> {
	// we're going to have to add documents to the list so collect them here and we'll add them when we're done
	const newDocs: CollectedGraphQLDocument[] = []

	// visit every document
	for (const doc of documents) {
		// remember if we ran into a paginate argument
		let paginated = false

		// store the pagination state to coordinate what we define as args to the field and the argument definitions of
		// the fragment and operation. we'll fill in the enabled state and default values once we encounter @paginate
		const flags: PaginationFlags = {
			first: {
				enabled: false,
				type: 'Int',
			},
			after: {
				enabled: false,
				type: 'String',
			},
			last: {
				enabled: false,
				type: 'Int',
			},
			before: {
				enabled: false,
				type: 'String',
			},
			limit: {
				enabled: false,
				type: 'Int',
			},
			offset: {
				enabled: false,
				type: 'Int',
			},
		}

		// we need to know the path where the paginate directive shows up so we can distinguish updated
		// values from data that needs to be added to the list
		let paginationPath: string[] = []

		// we need to add page info to the selection
		doc.document = graphql.visit(doc.document, {
			Field(node, _, __, ___, ancestors) {
				// if there's no paginate directive, ignore the field
				const paginateDirective = node.directives?.find(
					(directive) => directive.name.value === config.paginateDirective
				)
				if (!paginateDirective || !node.selectionSet) {
					return
				}

				// remember we saw this directive
				paginated = true

				// loop over the args of the field once so we can check their existence
				const args = new Set(
					(parentTypeFromAncestors(config.schema, ancestors) as
						| graphql.GraphQLObjectType
						| graphql.GraphQLInterfaceType)
						.getFields()
						[node.name.value].args.map((arg) => arg.name)
				)

				// also look to see if the user wants to do forward pagination
				const passedArgs = new Set(node.arguments?.map((arg) => arg.name.value))
				const specifiedForwards = passedArgs.has('first')
				const specifiedBackwards = passedArgs.has('last')

				// figure out what kind of pagination the field supports
				const forwardPagination =
					!specifiedBackwards && args.has('first') && args.has('after')
				const backwardsPagination =
					!specifiedForwards && args.has('last') && args.has('before')
				const offsetPagination =
					!forwardPagination &&
					!backwardsPagination &&
					args.has('offset') &&
					args.has('limit')

				// update the flags based on what the tagged field supports
				flags.first.enabled = forwardPagination
				flags.after.enabled = forwardPagination
				flags.last.enabled = backwardsPagination
				flags.before.enabled = backwardsPagination
				flags.offset.enabled = offsetPagination
				flags.limit.enabled = offsetPagination

				paginationPath = (ancestors
					.filter(
						(ancestor) =>
							// @ts-ignore
							!Array.isArray(ancestor) && ancestor.kind === graphql.Kind.FIELD
					)
					.concat(node) as graphql.FieldNode[]).map(
					(field) => field.alias?.value || field.name.value
				)

				// if the field supports cursor based pagination we need to make sure we have the
				// page info field
				return {
					...node,
					// any pagination arguments we run into will need to be replaced with variables
					// since they will be hoisted into the arguments for the fragment or query
					arguments: replaceArgumentsWithVariables(node.arguments, flags),
					selectionSet: offsetPagination
						? // no need to add any fields to the selection if we're dealing with offset pagination
						  node.selectionSet
						: // add the page info if we are dealing with cursor-based pagination
						  {
								...node.selectionSet,
								selections: [...node.selectionSet.selections, ...pageInfoSelection],
						  },
				}
			},
		})

		// if we saw the paginate directive we need to add arguments to the fragment or query that contain the
		// field that is marked for pagination
		if (paginated) {
			let fragmentName = ''
			let refetchQueryName = ''
			// check if we have to embed the fragment in Node
			let nodeQuery = false

			// figure out the right refetch
			let refetchUpdate = RefetchUpdateMode.append
			if (flags.last.enabled) {
				refetchUpdate = RefetchUpdateMode.prepend
			}

			// remember if we found a fragment or operation
			let fragment = ''

			doc.document = graphql.visit(doc.document, {
				// if we are dealing with a query, we'll need to add the variables to the definition
				OperationDefinition(node) {
					// make sure its a query
					if (node.operation !== 'query') {
						throw new Error(
							`@${config.paginateDirective} can only show up in a query or fragment document`
						)
					}

					refetchQueryName = node.name?.value || ''

					// build a map from existing variables to their value so we can compare with the ones we need to inject
					const operationVariables: Record<string, graphql.VariableDefinitionNode> =
						node.variableDefinitions?.reduce(
							(vars, definition) => ({
								...vars,
								[definition.variable.name.value]: definition,
							}),
							{}
						) || {}

					// figure out the variables we want on the query
					let newVariables: Record<
						string,
						graphql.VariableDefinitionNode
					> = Object.fromEntries(
						Object.entries(flags)
							.filter(([, spec]) => spec.enabled)
							.map(([fieldName, spec]) => [
								fieldName,
								staticVariableDefinition(fieldName, spec.type, spec.defaultValue),
							])
					)

					// the full list of variables comes from both source
					const variableNames = new Set<string>(
						Object.keys(operationVariables).concat(Object.keys(newVariables))
					)

					// we need to build a unique set of variable definitions
					const finalVariables = [...variableNames].map(
						(name) => operationVariables[name] || newVariables[name]
					)

					return {
						...node,
						variableDefinitions: finalVariables,
					} as graphql.OperationDefinitionNode
				},
				// if we are dealing with a fragment definition we'll need to add the arguments directive if it doesn't exist
				FragmentDefinition(node) {
					fragment = node.typeCondition.name.value

					fragmentName = node.name.value
					refetchQueryName = config.paginationQueryName(fragmentName)

					// a fragment has to be embedded in Node if its not on the query type
					nodeQuery = node.typeCondition.name.value !== config.schema.getQueryType()?.name

					// look at the fragment definition for an arguments directive
					const argDirective = node.directives?.find(
						(directive) => directive.name.value === config.argumentsDirective
					)

					// if there isn't an arguments directive, add it and we'll add arguments to it when
					// we run into it again
					if (!argDirective) {
						return {
							...node,
							directives: [
								...(node.directives || []),
								{
									kind: 'Directive',
									name: {
										kind: 'Name',
										value: config.argumentsDirective,
									},
								},
							] as graphql.DirectiveNode[],
						}
					}
				},
				Directive(node) {
					// if we are not looking at the arguments directive, ignore it
					if (node.name.value !== config.argumentsDirective) {
						return
					}

					// turn the set of enabled pagination args into arg definitions for the directive
					let newArgs = [
						...Object.entries(flags)
							.filter(([, spec]) => spec.enabled)
							.map(([key, spec]) =>
								argumentNode(key, [spec.type, spec.defaultValue])
							),
					]

					// add non-null versions of the arguments we'll use to paginate
					return {
						...node,
						arguments: [...(node.arguments || []), ...newArgs],
					} as graphql.DirectiveNode
				},
			})

			// now that we've mutated the document to be flexible for @paginate's needs
			// we need to add a document to perform the query if we are paginating on a
			// fragment

			// figure out the 'target' type of the refetch
			let targetType = config.schema.getQueryType()?.name || ''
			if (fragment) {
				const nodeInterface = config.schema.getType('Node') as graphql.GraphQLInterfaceType
				if (nodeInterface) {
					const { objects, interfaces } = config.schema.getImplementations(nodeInterface)

					if (
						objects.find((obj) => obj.name === fragment) ||
						interfaces.find((int) => int.name === fragment)
					) {
						targetType = 'Node'
					} else {
						targetType = fragment
					}
				} else {
					targetType = fragment
				}
			}

			// add the paginate info to the collected document
			doc.refetch = {
				update: refetchUpdate,
				path: paginationPath,
				method: flags.first.enabled || flags.last.enabled ? 'cursor' : 'offset',
				pageSize: 0,
				embedded: nodeQuery,
				targetType,
			}

			// add the correct default page size
			if (flags.first.enabled) {
				doc.refetch.pageSize = flags.first.defaultValue
				doc.refetch.start = flags.after.defaultValue
			} else if (flags.last.enabled) {
				doc.refetch.pageSize = flags.last.defaultValue
				doc.refetch.start = flags.before.defaultValue
			} else if (flags.limit.enabled) {
				doc.refetch.pageSize = flags.limit.defaultValue
				doc.refetch.start = flags.offset.defaultValue
			}

			// if we're not paginating a fragment, there's nothing more to do. we mutated
			// the query's definition to contain the arguments we need to get more data
			// and we can just use it for refetches
			if (!fragment) {
				continue
			}
			// grab the enabled fields to create the list of arguments for the directive
			const paginationArgs = Object.entries(flags)
				.filter(([_, { enabled }]) => enabled)
				.map(([key, value]) => ({ name: key, ...value }))

			const fragmentSpreadSelection = [
				{
					kind: 'FragmentSpread',
					name: {
						kind: 'Name',
						value: fragmentName,
					},
					directives: [
						{
							kind: 'Directive',
							name: {
								kind: 'Name',
								value: config.withDirective,
							},
							['arguments']: paginationArgs.map(({ name }) =>
								variableAsArgument(name)
							),
						},
					],
				},
			] as graphql.SelectionNode[]

			// we are going to add arguments for every key the type is configured with
			const keys = config
				.keyFieldsForType(!nodeQuery ? config.schema.getQueryType()?.name || '' : fragment)
				.flatMap((key) => {
					// if we are looking at the query, don't add anything
					if (fragment === config.schema.getQueryType()?.name) {
						return []
					}

					// look up the type for each key
					const fragmentType = config.schema.getType(fragment) as
						| graphql.GraphQLObjectType
						| graphql.GraphQLInterfaceType

					const { type, wrappers } = unwrapType(
						config,
						fragmentType.getFields()[key].type
					)

					return [
						{
							name: key,
							type: wrapType({ type, wrappers }),
						},
					]
				})

			const queryDoc: graphql.DocumentNode = {
				kind: 'Document',
				definitions: [
					{
						kind: 'OperationDefinition',
						name: {
							kind: 'Name',
							value: refetchQueryName,
						},
						operation: 'query',
						variableDefinitions: paginationArgs
							.map(
								(arg) =>
									({
										kind: 'VariableDefinition',
										type: {
											kind: 'NamedType',
											name: {
												kind: 'Name',
												value: arg.type,
											},
										},
										variable: {
											kind: 'Variable',
											name: {
												kind: 'Name',
												value: arg.name,
											},
										},
										defaultValue: !flags[arg.name].defaultValue
											? undefined
											: {
													kind: (arg.type + 'Value') as
														| 'IntValue'
														| 'StringValue',
													value: flags[arg.name].defaultValue,
											  },
									} as graphql.VariableDefinitionNode)
							)
							.concat(
								!nodeQuery
									? []
									: keys.map(
											(key) =>
												({
													kind: 'VariableDefinition',
													type: key.type,
													variable: {
														kind: 'Variable',
														name: {
															kind: 'Name',
															value: key.name,
														},
													},
												} as graphql.VariableDefinitionNode)
									  )
							),
						selectionSet: {
							kind: 'SelectionSet',
							selections: !nodeQuery
								? fragmentSpreadSelection
								: [
										{
											kind: 'Field',
											name: {
												kind: 'Name',
												value:
													config.typeConfig?.[fragment]?.resolve
														?.queryField || 'node',
											},
											['arguments']: keys.map((key) => ({
												kind: 'Argument',
												name: {
													kind: 'Name',
													value: key.name,
												},
												value: {
													kind: 'Variable',
													name: {
														kind: 'Name',
														value: key.name,
													},
												},
											})),
											selectionSet: {
												kind: 'SelectionSet',
												selections: fragmentSpreadSelection,
											},
										},
								  ],
						},
					},
				],
			}

			// add a document to the list
			newDocs.push({
				kind: ArtifactKind.Query,
				filename: doc.filename,
				name: refetchQueryName,
				document: queryDoc,
				originalDocument: queryDoc,
				generate: true,
				refetch: doc.refetch,
			})
		}
	}

	// add every new doc we generated to the list
	documents.push(...newDocs)
}

function replaceArgumentsWithVariables(
	args: readonly graphql.ArgumentNode[] | undefined,
	flags: PaginationFlags
): graphql.ArgumentNode[] {
	const seenArgs: Record<string, boolean> = {}

	const newArgs = (args || []).map((arg) => {
		// the specification for this variable
		const spec = flags[arg.name.value]
		// if the arg is not something we care about or is disabled we need to leave it alone
		if (!spec || !spec.enabled) {
			return arg
		}

		// if the argument isn't being passed a variable, we will need to set a default value
		if (arg.value.kind !== 'Variable') {
			const oldValue = (arg.value as graphql.StringValueNode).value

			// transform the value if we have to and save the default value
			flags[arg.name.value].defaultValue = spec.type === 'Int' ? parseInt(oldValue) : oldValue
		}

		seenArgs[arg.name.value] = true

		// turn the field into a variable
		return variableAsArgument(arg.name.value)
	})

	// any fields that are enabled but don't have values need to have variable references add
	for (const name of Object.keys(flags)) {
		// the specification for this variable
		const spec = flags[name]

		// if we have a value or its disabled, ignore it
		if (flags[name].defaultValue || !spec.enabled || seenArgs[name]) {
			continue
		}

		// if we are looking at forward pagination args when backwards is enabled ignore it
		if (['first', 'after'].includes(name) && flags['before'].enabled) {
			continue
		}
		// same but opposite for backwards pagination
		if (['last', 'before'].includes(name) && flags['first'].enabled) {
			continue
		}

		// we need to add a variable referencing the argument
		newArgs.push(variableAsArgument(name))
	}

	return newArgs
}

function variableAsArgument(name: string): graphql.ArgumentNode {
	return {
		kind: 'Argument',
		name: {
			kind: 'Name',
			value: name,
		},
		value: {
			kind: 'Variable',
			name: {
				kind: 'Name',
				value: name,
			},
		},
	}
}

function staticVariableDefinition(name: string, type: string, defaultValue?: string) {
	return {
		kind: 'VariableDefinition',
		type: {
			kind: 'NamedType',
			name: {
				kind: 'Name',
				value: type,
			},
		},
		variable: {
			kind: 'Variable',
			name: {
				kind: 'Name',
				value: name,
			},
		},
		defaultValue: !defaultValue
			? undefined
			: {
					kind: (type + 'Value') as 'IntValue' | 'StringValue',
					value: defaultValue,
			  },
	} as graphql.VariableDefinitionNode
}

function argumentNode(
	name: string,
	value: [string, number | string | undefined]
): graphql.ArgumentNode {
	return {
		kind: 'Argument',
		name: {
			kind: 'Name',
			value: name,
		},
		value: objectNode(value),
	}
}

function objectNode([type, defaultValue]: [
	string,
	number | string | undefined
]): graphql.ObjectValueNode {
	const node = {
		kind: 'ObjectValue' as 'ObjectValue',
		fields: [
			{
				kind: 'ObjectField',
				name: {
					kind: 'Name',
					value: 'type',
				},
				value: {
					kind: 'StringValue',
					value: type,
				},
			},
		] as graphql.ObjectFieldNode[],
	}

	// if there's a default value, add it
	if (defaultValue) {
		node.fields.push({
			kind: 'ObjectField',
			name: { kind: 'Name', value: 'default' } as graphql.NameNode,
			value: {
				kind: typeof defaultValue === 'number' ? 'IntValue' : 'StringValue',
				value: defaultValue.toString(),
			},
		} as graphql.ObjectFieldNode)
	}

	return node
}

export const pageInfoSelection = [
	{
		kind: 'Field',
		name: {
			kind: 'Name',
			value: 'edges',
		},
		selectionSet: {
			kind: 'SelectionSet',
			selections: [
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'cursor',
					},
				},
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'node',
					},
					selectionSet: {
						kind: 'SelectionSet',
						selections: [
							{
								kind: 'Field',
								name: {
									kind: 'Name',
									value: '__typename',
								},
							},
						],
					},
				},
			],
		},
	},
	{
		kind: 'Field',
		name: {
			kind: 'Name',
			value: 'pageInfo',
		},
		selectionSet: {
			kind: 'SelectionSet',
			selections: [
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'hasPreviousPage',
					},
				},
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'hasNextPage',
					},
				},
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'startCursor',
					},
				},
				{
					kind: 'Field',
					name: {
						kind: 'Name',
						value: 'endCursor',
					},
				},
			],
		},
	},
]
